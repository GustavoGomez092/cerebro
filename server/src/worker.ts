import type { SQL } from "bun";
import { EmbedderError, toVector, type Embedder } from "./embed/embedder";

/**
 * Lets searches jump the embedder queue: while any search is embedding its query, the
 * worker waits before sending its next batch.
 */
export class EmbedGate {
  private active = 0;
  private idle: (() => void)[] = [];
  enter() { this.active++; }
  leave() {
    this.active = Math.max(0, this.active - 1);
    if (this.active === 0) for (const r of this.idle.splice(0)) r();
  }
  get busy() { return this.active > 0; }
  /** Resolves when no search is embedding (or after `maxWaitMs`, so the worker never starves). */
  async whenIdle(maxWaitMs = 30_000): Promise<void> {
    if (!this.busy) return;
    await Promise.race([new Promise<void>((r) => this.idle.push(r)), Bun.sleep(maxWaitMs)]);
  }
}

export interface WorkerState {
  pausedUntil: number;
  pauseMs: number;
  lastSuccessAt: string | null;
  lastError: string | null;
}
export const newWorkerState = (): WorkerState => ({ pausedUntil: 0, pauseMs: 0, lastSuccessAt: null, lastError: null });

const PAUSE_MIN_MS = 5_000, PAUSE_MAX_MS = 5 * 60_000;
/** Known-good text: if it fails too, the embedder is broken and no chunk is to blame. */
const CANARY = "cerebro embedder health check";
const RETRY_BASE_S = 30, RETRY_MAX_S = 6 * 3600;

interface Claimed { chunk_id: number; text: string }

export interface EmbedOptions {
  state: WorkerState;
  gate?: EmbedGate;
  /** Chunks claimed per run. */
  limit?: number;
  /** Batch budget in characters and items (bge-m3 on a small CPU is slow; keep batches short). */
  batchChars?: number;
  maxBatch?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
}

/**
 * Claims ready chunks (live before imported) with a lease, embeds them in small batches and
 * commits each batch. A failing batch is retried item by item; a failing item backs off and is
 * dead-lettered after `maxAttempts`. If the embedder is unreachable the worker pauses and
 * releases its leases without charging attempts.
 */
export async function embedPending(sql: SQL, embedder: Embedder, opts: EmbedOptions) {
  const { state } = opts;
  const limit = opts.limit ?? 32, batchChars = opts.batchChars ?? 6000, maxBatch = opts.maxBatch ?? 8;
  const leaseSeconds = opts.leaseSeconds ?? 600, maxAttempts = opts.maxAttempts ?? 5;
  const result = { claimed: 0, embedded: 0, failed: 0, dead: 0, paused: false };
  if (state.pausedUntil > Date.now()) return { ...result, paused: true };

  const claimed: Claimed[] = await sql`
    with picked as (
      select chunk_id from embed_queue
      where not dead and next_attempt_at <= now() and (locked_until is null or locked_until < now())
      order by priority, chunk_id
      limit ${limit}
      for update skip locked)
    update embed_queue q set locked_until = now() + make_interval(secs => ${leaseSeconds})
    from picked, chunks c
    where q.chunk_id = picked.chunk_id and c.id = q.chunk_id
    returning q.chunk_id, c.text`;
  result.claimed = claimed.length;
  claimed.sort((a, b) => a.chunk_id - b.chunk_id);

  const batches: Claimed[][] = [];
  for (const c of claimed) {
    const last = batches[batches.length - 1];
    const size = last?.reduce((n, x) => n + x.text.length, 0) ?? 0;
    if (!last || last.length >= maxBatch || size + c.text.length > batchChars) batches.push([c]);
    else last.push(c);
  }

  const store = async (items: Claimed[], vectors: number[][]) => {
    await sql.begin(async (tx) => {
      for (const [i, item] of items.entries()) {
        await tx`
          insert into chunk_embeddings (chunk_id, embedding) values (${item.chunk_id}, ${toVector(vectors[i])}::text::halfvec)
          on conflict (chunk_id) do update set embedding = excluded.embedding`;
      }
      await tx`delete from embed_queue where chunk_id = any(${tx.array(items.map((x) => x.chunk_id), "int8")})`;
    });
    result.embedded += items.length;
    state.lastSuccessAt = new Date().toISOString();
    state.pauseMs = 0;
  };
  const charge = async (item: Claimed, err: Error) => {
    const [row] = await sql`
      update embed_queue set
        attempts = attempts + 1,
        last_error = ${err.message.slice(0, 500)},
        locked_until = null,
        next_attempt_at = now() + make_interval(secs => least(${RETRY_MAX_S}, ${RETRY_BASE_S} * power(2, attempts))),
        dead = attempts + 1 >= ${maxAttempts}
      where chunk_id = ${item.chunk_id} returning dead`;
    result.failed++;
    if (row?.dead) result.dead++;
  };
  const pause = async (pending: Claimed[], err: Error) => {
    state.pauseMs = Math.min(PAUSE_MAX_MS, Math.max(PAUSE_MIN_MS, state.pauseMs * 2));
    state.pausedUntil = Date.now() + state.pauseMs;
    state.lastError = err.message;
    result.paused = true;
    if (pending.length) await sql`update embed_queue set locked_until = null where chunk_id = any(${sql.array(pending.map((x) => x.chunk_id), "int8")})`;
  };
  const isTransient = (e: unknown) => e instanceof EmbedderError && e.transient;
  let canaryOk: boolean | null = null;
  const embedderHealthy = async () => {
    if (canaryOk === null) canaryOk = await embedder.embed([CANARY]).then(() => true, () => false);
    return canaryOk;
  };

  for (const [bi, batch] of batches.entries()) {
    await opts.gate?.whenIdle();
    try {
      await store(batch, await embedder.embed(batch.map((x) => x.text)));
      continue;
    } catch (e) {
      if (isTransient(e)) { await pause(batches.slice(bi).flat(), e as Error); return result; }
      state.lastError = (e as Error).message;
    }
    // Isolate the bad item(s): retry one at a time.
    for (const [ii, item] of batch.entries()) {
      try {
        await store([item], await embedder.embed([item.text]));
      } catch (e) {
        if (isTransient(e) || !(await embedderHealthy())) {
          await pause([...batch.slice(ii), ...batches.slice(bi + 1).flat()], e as Error);
          return result;
        }
        state.lastError = (e as Error).message;
        await charge(item, e as Error);
      }
    }
  }
  return result;
}

/** Puts dead-lettered chunks back in the queue (after fixing the embedder). Returns how many. */
export async function requeueDead(sql: SQL): Promise<number> {
  const rows = await sql`
    update embed_queue set dead = false, attempts = 0, next_attempt_at = now(), locked_until = null, last_error = null
    where dead returning chunk_id`;
  return rows.length;
}

/** Runs embedPending continuously; never throws. */
export function startEmbedWorker(sql: SQL, embedder: Embedder, opts: { state: WorkerState; gate?: EmbedGate; idleMs?: number }) {
  let stopped = false;
  let current: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    if (stopped) return;
    current = embedPending(sql, embedder, opts)
      .then((r) => (r.claimed > 0 && !r.paused ? 0 : opts.idleMs ?? 2000))
      .catch((e) => { console.error(JSON.stringify({ level: "error", msg: "embed worker", error: (e as Error).message })); return 5000; })
      .then((delay) => { if (!stopped) timer = setTimeout(tick, delay); });
  };
  tick();
  return {
    async stop() { stopped = true; clearTimeout(timer); await current; },
  };
}
