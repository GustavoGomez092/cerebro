import { SQL } from "bun";
import { connect, migrate } from "../src/db";

export const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://cerebro:cerebro@127.0.0.1:54329/cerebro";

export async function freshDb(): Promise<{ sql: SQL; drop(): Promise<void> }> {
  const name = `cerebro_test_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = connect(ADMIN_URL);
  await admin.unsafe(`create database ${name}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const sql = connect(url.toString());
  await migrate(sql);
  return {
    sql,
    async drop() {
      await sql.close();
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.close();
    },
  };
}

import type { Hono } from "hono";
import { createApp } from "../src/http/app";
import { createToken } from "../src/auth";

export async function authedApp(opts: { embedder?: any } = {}) {
  const db = await freshDb();
  const { token, machineId } = await createToken(db.sql, "test-mac");
  const app: Hono = createApp({ sql: db.sql, embedder: opts.embedder ?? null });
  const call = (method: string, path: string, body?: unknown, tok: string | null = token) =>
    app.request(path, {
      method,
      headers: {
        ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  return { app, sql: db.sql, token, machineId, call, drop: db.drop };
}
