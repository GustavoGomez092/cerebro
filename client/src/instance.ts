import { ApiError, verificationRecord, verifiedAt, VERIFIED_KEY, type ApiClient } from "./api";
import type { BlockedReason, Store } from "./store";

export type InstanceCheck = "ok" | "mismatch" | "unreachable";

/**
 * Asks the unauthenticated `/health` which Cerebro instance answers, so an impostor never sees the token.
 * Pins the instance on first contact; a different one sets `blocked = instance_mismatch`.
 * Network failures and answers without an instance id are "unreachable". Store errors propagate.
 * An "ok" is recorded in the store, and for the next minute lets the ApiClient send authenticated calls
 * to this server; any other answer withdraws an earlier one.
 */
export async function checkInstance(store: Store, api: ApiClient, opts: { timeoutMs: number }): Promise<InstanceCheck> {
  let health: { ok: boolean; instanceId: string | null } | undefined;
  try {
    health = await api.health({ timeoutMs: opts.timeoutMs });
  } catch (e) {
    if (e instanceof ApiError) return unverified(store, "unreachable");
    throw e;
  }
  // A captive portal can answer 200 with HTML, which parses to no body at all.
  if (!health?.ok || typeof health.instanceId !== "string" || !health.instanceId) return unverified(store, "unreachable");
  const pinned = store.get("instanceId");
  if (pinned === undefined) store.set("instanceId", health.instanceId);
  else if (pinned !== health.instanceId) {
    store.set("blocked", "instance_mismatch" satisfies BlockedReason);
    return unverified(store, "mismatch");
  }
  store.set(VERIFIED_KEY, verificationRecord(api.serverUrl, health.instanceId));
  return "ok";
}

function unverified(store: Store, result: InstanceCheck): InstanceCheck {
  store.set(VERIFIED_KEY, null);
  return result;
}

export type Verification = InstanceCheck | "blocked";

/**
 * What every caller runs before authenticated calls: "ok" when they may go out now. A blocked store
 * ("blocked") is never checked again until `cerebro status --retry` or `reset-instance` lifts the block.
 * `reuseMs` skips the network when this server was verified that recently (long loops re-verify cheaply).
 */
export async function verifyServer(
  store: Store, api: ApiClient, opts: { timeoutMs: number; reuseMs?: number },
): Promise<Verification> {
  if (store.get("blocked")) return "blocked";
  if (opts.reuseMs) {
    const at = verifiedAt(store, api.serverUrl);
    if (at !== null && Date.now() - at >= 0 && Date.now() - at < opts.reuseMs) return "ok";
  }
  return checkInstance(store, api, { timeoutMs: opts.timeoutMs });
}
