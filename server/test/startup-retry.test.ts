import { expect, test } from "bun:test";
import { buildServer } from "../src/main";

test("buildServer keeps retrying an unreachable database until its wait budget is spent", async () => {
  const t0 = Date.now();
  await expect(
    buildServer({ DATABASE_URL: "postgres://cerebro:x@127.0.0.1:1/cerebro", EMBED_URL: "http://127.0.0.1:1" }, { dbWaitMs: 1500 }),
  ).rejects.toThrow();
  expect(Date.now() - t0).toBeGreaterThanOrEqual(1000);
}, 15_000);
