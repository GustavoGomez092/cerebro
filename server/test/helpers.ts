import { SQL } from "bun";
import { connect, migrate } from "../src/db";
import { createApp, type AppDeps } from "../src/http/app";
import { createToken } from "../src/auth";
import { fakeEmbedder } from "../src/embed/fake";
import type { Embedder } from "../src/embed/embedder";

export const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://cerebro:cerebro@127.0.0.1:54329/cerebro";

export async function freshDb(opts: { migrate?: boolean } = {}): Promise<{ sql: SQL; url: string; drop(): Promise<void> }> {
  const name = `cerebro_test_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = connect(ADMIN_URL, { max: 1 });
  await admin.unsafe(`create database ${name}`);
  const u = new URL(ADMIN_URL);
  u.pathname = `/${name}`;
  const url = u.toString();
  const sql = connect(url);
  if (opts.migrate !== false) await migrate(sql);
  return {
    sql,
    url,
    async drop() {
      await sql.close();
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.close();
    },
  };
}

export async function authedApp(opts: { embedder?: Embedder; deps?: Partial<AppDeps> } = {}) {
  const db = await freshDb();
  const { token, machineId } = await createToken(db.sql, "test-mac");
  const embedder = opts.embedder ?? fakeEmbedder();
  const app = createApp({ sql: db.sql, embedder, log: () => {}, ...opts.deps });
  const call = (method: string, path: string, body?: unknown, tok: string | null = token) =>
    app.request(path, {
      method,
      headers: {
        ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  return { app, sql: db.sql, url: db.url, token, machineId, embedder, call, drop: db.drop };
}
