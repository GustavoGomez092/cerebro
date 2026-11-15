import { readFileSync } from "node:fs";

export interface WebEnv {
  databaseUrl: string;
  /** BETTER_AUTH_SECRET: signs session cookies. */
  authSecret: string;
  /** BETTER_AUTH_URL: the address the browser uses (http://brain.home.lab). Also the only trusted origin. */
  baseUrl: string;
  /** cerebro-server, reached on the compose network. */
  cerebroUrl: string;
  /** The `web-ui` machine token. Server-side only: never sent to the browser. */
  cerebroToken: string;
}

const need = (env: Record<string, string | undefined>, k: string) => {
  const v = (env[k] ?? "").trim();
  if (!v) throw new Error(`${k} is required`);
  return v;
};

/** The web app's settings; a missing or weak one stops it at startup. */
export function loadWebEnv(env: Record<string, string | undefined> = process.env): WebEnv {
  const authSecret = need(env, "BETTER_AUTH_SECRET");
  if (authSecret.length < 32) throw new Error("BETTER_AUTH_SECRET must be at least 32 characters (openssl rand -base64 32)");
  let cerebroToken = (env.CEREBRO_WEB_TOKEN ?? "").trim();
  if (!cerebroToken && env.CEREBRO_WEB_TOKEN_FILE) cerebroToken = readFileSync(env.CEREBRO_WEB_TOKEN_FILE, "utf8").trim();
  if (!cerebroToken) throw new Error("CEREBRO_WEB_TOKEN (or CEREBRO_WEB_TOKEN_FILE) is required: the web-ui machine token");
  return {
    databaseUrl: need(env, "DATABASE_URL"),
    authSecret,
    baseUrl: need(env, "BETTER_AUTH_URL").replace(/\/+$/, ""),
    cerebroUrl: (env.CEREBRO_URL ?? "").trim().replace(/\/+$/, "") || "http://cerebro-server:8790",
    cerebroToken,
  };
}
