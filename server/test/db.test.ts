import { test, expect } from "bun:test";
import { freshDb } from "./helpers";
import { migrate } from "../src/db";
import { loadConfig } from "../src/config";

test("migrate creates schema and is idempotent", async () => {
  const { sql, drop } = await freshDb();
  try {
    expect(await migrate(sql)).toEqual([]);
    const [{ n }] = await sql`select count(*)::int as n from clients where name = 'Personal'`;
    expect(n).toBe(1);
    const cols = await sql`select column_name from information_schema.columns where table_name = 'chunks'`;
    expect(cols.map((c: any) => c.column_name)).toContain("embedding");
  } finally {
    await drop();
  }
});

test("loadConfig applies defaults and requires DATABASE_URL", () => {
  expect(loadConfig({ DATABASE_URL: "postgres://x" })).toEqual({
    databaseUrl: "postgres://x", port: 8790, embedUrl: null, embedModel: "bge-m3", embedDims: 1024,
  });
  expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
});
