import { randomBytes, timingSafeEqual } from "node:crypto";

export interface ChatRun {
  id: string;
  /** The bearer secret this run's CLI uses for /mcp/chat; valid only until end(). Never logged. */
  secret: string;
  end(): void;
}

/** The chat runs in progress: a small concurrency cap, and each run's one-off MCP secret. */
export class ChatRuns {
  private readonly active = new Map<string, Buffer>();
  constructor(readonly max: number) {}

  get count(): number { return this.active.size; }

  /** A new run, or null when `max` runs are already going. */
  tryBegin(): ChatRun | null {
    if (this.active.size >= this.max) return null;
    const id = randomBytes(8).toString("hex");
    const secret = randomBytes(32).toString("base64url");
    this.active.set(id, Buffer.from(secret));
    return { id, secret, end: () => { this.active.delete(id); } };
  }

  /** Whether `secret` belongs to a run in progress (constant-time per comparison). */
  accepts(secret: string): boolean {
    const got = Buffer.from(secret);
    let ok = false;
    for (const want of this.active.values()) if (want.length === got.length && timingSafeEqual(want, got)) ok = true;
    return ok;
  }
}
