// Better Auth: one owner account (email + password), no public sign-up, sessions in Postgres (schema `auth`,
// created by server migration 008), sign-in rate limited.
import { betterAuth } from "better-auth";
import { Pool } from "pg";
import { loadWebEnv } from "./env.server";

export const MIN_PASSWORD = 12;

/**
 * A small pool whose search_path is the `auth` schema, so Better Auth's unqualified tables land there. An idle
 * connection the database drops (a db restart) is logged, by code only, instead of crashing the process.
 */
export function authPool(databaseUrl: string): Pool {
  const pool = new Pool({ connectionString: databaseUrl, options: "-c search_path=auth", max: 5 });
  pool.on("error", (e: Error & { code?: string }) =>
    console.error(JSON.stringify({ level: "warn", msg: "auth database connection lost", code: e.code ?? e.name })));
  return pool;
}

export function authOptions(o: { pool: Pool; secret: string; baseURL: string }) {
  return {
    database: o.pool,
    secret: o.secret,
    baseURL: o.baseURL,
    trustedOrigins: [o.baseURL],
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: MIN_PASSWORD },
    session: { expiresIn: 7 * 24 * 3600, updateAge: 24 * 3600 },
    // In memory (one web container); the client address comes from Caddy's X-Forwarded-For.
    rateLimit: {
      enabled: true, storage: "memory" as const, window: 60, max: 100,
      customRules: { "/sign-in/email": { window: 60, max: 5 } },
    },
    advanced: {
      // LAN-only plain http: a Secure cookie would never be sent back. httpOnly + SameSite=Lax still apply.
      useSecureCookies: false,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" as const, secure: false },
    },
    telemetry: { enabled: false },
  };
}

export const createAuth = (o: { pool: Pool; secret: string; baseURL: string }) => betterAuth(authOptions(o));
export type Auth = ReturnType<typeof createAuth>;

let instance: Auth | undefined;
/** The app's Better Auth, built on first use from the environment (so importing this module needs no secrets). */
export function getAuth(): Auth {
  if (!instance) {
    const env = loadWebEnv();
    instance = createAuth({ pool: authPool(env.databaseUrl), secret: env.authSecret, baseURL: env.baseUrl });
  }
  return instance;
}
