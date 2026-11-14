import { ApiError, type ApiClient } from "./api";
import type { BlockedReason, Store } from "./store";

export type InstanceCheck = "ok" | "mismatch" | "unreachable";

/**
 * Asks the unauthenticated `/health` which Cerebro instance answers, so an impostor never sees the token.
 * Pins the instance on first contact; a different one sets `blocked = instance_mismatch`.
 * Network failures and answers without an instance id are "unreachable". Store errors propagate.
 */
export async function checkInstance(store: Store, api: ApiClient, opts: { timeoutMs: number }): Promise<InstanceCheck> {
  let health: { ok: boolean; instanceId: string | null } | undefined;
  try {
    health = await api.health({ timeoutMs: opts.timeoutMs });
  } catch (e) {
    if (e instanceof ApiError) return "unreachable";
    throw e;
  }
  // A captive portal can answer 200 with HTML, which parses to no body at all.
  if (!health?.ok || typeof health.instanceId !== "string" || !health.instanceId) return "unreachable";
  const pinned = store.get("instanceId");
  if (pinned === undefined) store.set("instanceId", health.instanceId);
  else if (pinned !== health.instanceId) {
    store.set("blocked", "instance_mismatch" satisfies BlockedReason);
    return "mismatch";
  }
  return "ok";
}
