// cerebro-web's database URL in tests: the cerebro_web role (migration 009) with a fresh password, as on the Zima.
import type { SQL } from "bun";
import { setWebDbRole } from "../../server/src/web-db-role";

export async function webDbUrl(db: { sql: SQL; url: string }): Promise<string> {
  return (await setWebDbRole(db.sql, db.url)).slice("DATABASE_URL=".length);
}
