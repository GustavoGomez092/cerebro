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

interface Claimed { chunk_id: number; text: string; priority?: number }

/** A machine lane's chunks wait this long after its endpoint failed (then the Zima lane may take them). */
export const DEFER_S = 30;
/** The Zima lane claims a few chunks at a time (~4.5 s each), so its leases stay short. */
const ZIMA_LANE_LIMIT = 4;

/**
 * Which chunks a run claims, by the machine that uploaded their session (EMBED_MACHINE_URLS).
 * `machine`: that machine's chunks only, for its own endpoint; a failing endpoint defers them, never pauses.
 * `zima`: chunks of machines not in `mapped`, then those of `waiting` (mapped, endpoint down or mismatched).
 */
export interface EmbedRoute {
  machine?: string;
  zima?: { mapped: string[]; waiting: string[] };
}

export interface EmbedOptions {
  state: WorkerState;
  gate?: EmbedGate;
  /** Chunks claimed per run. */
  limit?: number;
  /** Batch budget in characters and items. Default: one chunk per call. bge-m3 takes ~4.5 s per 1 600-char chunk on
   * the Zima CPU (benchmark 2026-11-14), and a search query waits behind the call in flight. */
  batchChars?: number;
  maxBatch?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
  route?: EmbedRoute;
}

/**
 * Claims ready chunks (live before imported) with a lease, embeds them in small batches and
 * commits each batch. A failing batch is retried item by item; a failing item backs off and is
 * dead-lettered after `maxAttempts`. If the embedder is unreachable the worker pauses and
 * releases its leases without charging attempts.
 */
export async function embedPending(sql: SQL, embedder: Embedder, opts: EmbedOptions) {
  const { state } = opts;
  const limit = opts.limit ?? 32, batchChars = opts.batchChars ?? 6000, maxBatch = opts.maxBatch ?? 1;
  const leaseSeconds = opts.leaseSeconds ?? 600, maxAttempts = opts.maxAttempts ?? 5;
  const result = { claimed: 0, embedded: 0, failed: 0, dead: 0, paused: false };
  const lane = opts.route?.machine ?? null;
  if (lane === null && state.pausedUntil > Date.now()) return { ...result, paused: true };

  let claimed: Claimed[];
  if (!opts.route) {
    claimed = await sql`
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
    claimed.sort((a, b) => a.chunk_id - b.chunk_id);
  } else {
    const q = claimQuery(opts.route, lane === null ? Math.min(limit, ZIMA_LANE_LIMIT) : limit, leaseSeconds);
    claimed = await sql.unsafe(q.text, q.params);
    // Live before imported, then (the Zima lane) unmapped machines' work before a down machine's.
    claimed.sort((a: any, b: any) => a.priority - b.priority || Number(a.waiting) - Number(b.waiting) || a.chunk_id - b.chunk_id);
  }
  result.claimed = claimed.length;

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
    if (lane !== null) {
      // This machine's endpoint is down: its chunks wait (no attempt charged); the worker itself doesn't pause.
      state.lastError = err.message;
      result.paused = true;
      if (pending.length) {
        await sql`update embed_queue set locked_until = null, next_attempt_at = now() + make_interval(secs => ${DEFER_S})
                  where chunk_id = any(${sql.array(pending.map((x) => x.chunk_id), "int8")})`;
      }
      return;
    }
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

/**
 * The routed claim (see EmbedRoute), as text and parameters: the worker runs it, tests EXPLAIN it. Each eligible
 * machine's ready rows come from embed_queue_machine_ready_idx (machine_id, priority, chunk_id), one index range
 * per machine, so a backlog never makes a claim scan the queue or join chunks beyond the rows it takes.
 * $1 the lane's machine (null: the Zima lane), $2 mapped machines, $3 waiting (down) machines, $4 limit, $5 lease.
 */
export function claimQuery(route: EmbedRoute, limit: number, leaseSeconds: number): { text: string; params: unknown[] } {
  const ready = "not q.dead and q.next_attempt_at <= now() and (q.locked_until is null or q.locked_until < now())";
  return {
    text: `
      with eligible as (
        select id, name = any($3::text[]) as waiting from machines
        where case when $1::text is not null then name = $1::text
                   else not (name = any($2::text[])) or name = any($3::text[]) end
      ), cand as (
        select x.chunk_id, x.priority, e.waiting from eligible e cross join lateral (
          select q.chunk_id, q.priority from embed_queue q
          where q.machine_id = e.id and ${ready}
          order by q.priority, q.chunk_id limit $4) x
        union all
        (select q.chunk_id, q.priority, false from embed_queue q
         where $1::text is null and q.machine_id is null and ${ready}
         order by q.priority, q.chunk_id limit $4)
      ), picked as (
        select q.chunk_id, cand.priority, cand.waiting from cand join embed_queue q on q.chunk_id = cand.chunk_id
        where ${ready}
        order by cand.priority, cand.waiting, cand.chunk_id
        limit $4
        for update of q skip locked)
      update embed_queue q set locked_until = now() + make_interval(secs => $5)
      from picked, chunks c
      where q.chunk_id = picked.chunk_id and c.id = q.chunk_id
      returning q.chunk_id, c.text, picked.priority, picked.waiting`,
    params: [route.machine ?? null, route.zima?.mapped ?? [], route.zima?.waiting ?? [], limit, leaseSeconds],
  };
}

export type EmbedResult = Awaited<ReturnType<typeof embedPending>>;

/**
 * The worker's independent lanes. Without machine endpoints (EMBED_MACHINE_URLS empty): one lane, `embedder`
 * for every chunk, as before. With them: one lane per mapped machine (its chunks, its endpoint only; skipped
 * while the endpoint sits out its down window) and a Zima lane (`embedder` itself: unmapped machines' chunks,
 * then the waiting chunks of machines whose endpoint is down or mismatched, so nothing is stranded).
 */
export function embedLanes(sql: SQL, embedder: Embedder, opts: EmbedOptions): { name: string; run(): Promise<EmbedResult> }[] {
  const lanes = embedder.lanes?.() ?? [];
  if (!lanes.length) return [{ name: "all", run: () => embedPending(sql, embedder, opts) }];
  const idle = { claimed: 0, embedded: 0, failed: 0, dead: 0, paused: true };
  return [
    ...lanes.map((l) => ({
      name: l.machine,
      run: async () => (l.blocked() ? idle : embedPending(sql, l.embedder, { ...opts, route: { machine: l.machine } })),
    })),
    {
      name: "zima",
      run: () => embedPending(sql, embedder, {
        ...opts,
        route: { zima: { mapped: lanes.map((l) => l.machine), waiting: lanes.filter((l) => l.blocked()).map((l) => l.machine) } },
      }),
    },
  ];
}

/** Puts dead-lettered chunks back in the queue (after fixing the embedder). Returns how many. */
export async function requeueDead(sql: SQL): Promise<number> {
  const rows = await sql`
    update embed_queue set dead = false, attempts = 0, next_attempt_at = now(), locked_until = null, last_error = null
    where dead returning chunk_id`;
  return rows.length;
}

/** Runs each lane (see embedLanes) in its own loop, so a slow or stuck lane never holds up another; never throws. */
export function startEmbedWorker(sql: SQL, embedder: Embedder, opts: { state: WorkerState; gate?: EmbedGate; idleMs?: number }) {
  let stopped = false;
  const loops = embedLanes(sql, embedder, opts).map((lane) => {
    const loop = { current: Promise.resolve() as Promise<unknown>, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    const tick = () => {
      if (stopped) return;
      loop.current = lane.run()
        .then((r) => (r.claimed > 0 && !r.paused ? 0 : opts.idleMs ?? 2000))
        .catch((e) => { console.error(JSON.stringify({ level: "error", msg: "embed worker", lane: lane.name, error: (e as Error).message })); return 5000; })
        .then((delay) => { if (!stopped) loop.timer = setTimeout(tick, delay); });
    };
    tick();
    return loop;
  });
  return {
    async stop() {
      stopped = true;
      for (const l of loops) clearTimeout(l.timer);
      await Promise.all(loops.map((l) => l.current));
    },
  };
}
