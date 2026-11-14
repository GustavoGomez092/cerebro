import type { SQL } from "bun";

const WINDOW_MS = 5 * 3600_000;
const RETENTION_MS = 7 * 24 * 3600_000;

export interface BudgetState {
  used: number;
  limit: number;
  remaining: number;
  resumesAt: Date | null;
}

export async function record(sql: SQL, tokens: number, kind: "summary" | "state" | "history"): Promise<void> {
  await sql`insert into usage_ledger (tokens, kind) values (${Math.round(tokens)}, ${kind})`;
}

export async function budgetState(
  sql: SQL,
  cfg: { share: number; windowTokens: number },
  now = new Date(),
): Promise<BudgetState> {
  const limit = Math.floor(cfg.share * cfg.windowTokens);
  const cutoff = new Date(now.getTime() - RETENTION_MS).toISOString();
  await sql`delete from usage_ledger where at < ${cutoff}`;
  const from = new Date(now.getTime() - WINDOW_MS).toISOString();
  const rows: { at: Date; tokens: number }[] =
    await sql`select at, tokens from usage_ledger where at > ${from} and at <= ${now.toISOString()} order by at`;
  const total = rows.reduce((a, r) => a + r.tokens, 0);
  let resumesAt: Date | null = null;
  if (total >= limit) {
    // Walk oldest-first until enough spending has left the window to be under the limit.
    let used = total;
    for (const r of rows) {
      used -= r.tokens;
      if (used < limit) {
        resumesAt = new Date(new Date(r.at).getTime() + WINDOW_MS);
        break;
      }
    }
  }
  return { used: total, limit, remaining: Math.max(0, limit - total), resumesAt };
}

export function canSpend(state: BudgetState, estimate: number): boolean {
  return state.remaining >= estimate;
}

/** Rough token estimate for a job: input chars / 3.5 plus fixed output/prompt overhead. */
export function estimateTokens(inputChars: number): number {
  return Math.ceil(inputChars / 3.5) + 4000;
}
