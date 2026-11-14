import type { SQL } from "bun";
import { mapStrings, redactSecrets } from "@cerebro/shared";
import { storeChunks } from "./chunk-store";

/**
 * Scrubs a session after a secret slipped through: applies the standard redaction plus an
 * optional extra pattern to every event, then rebuilds its search chunks (and their
 * embeddings) from the cleaned text. Returns how many events changed and chunks were rebuilt.
 */
export async function redactSession(sql: SQL, sessionId: string, pattern?: string): Promise<{ events: number; chunks: number }> {
  const extra = pattern ? new RegExp(pattern, "g") : null;
  const scrub = (s: string) => {
    const r = redactSecrets(s);
    return extra ? r.replace(extra, "[REDACTED:manual]") : r;
  };
  return sql.begin(async (tx) => {
    const [s] = await tx`select cwd, meta from sessions where id = ${sessionId}`;
    if (s) await tx`update sessions set cwd = ${scrub(s.cwd)}, meta = ${JSON.stringify(mapStrings(s.meta, scrub))}::text::jsonb where id = ${sessionId}`;
    const rows = await tx`select id, seq, ts, kind, text, tool_name, tool_input, meta from events where session_id = ${sessionId} order by seq`;
    let changed = 0;
    for (const r of rows) {
      const text = scrub(r.text);
      const toolInput = r.tool_input == null ? null : mapStrings(r.tool_input, scrub);
      const meta = mapStrings(r.meta, scrub);
      if (text === r.text && JSON.stringify(toolInput) === JSON.stringify(r.tool_input) && JSON.stringify(meta) === JSON.stringify(r.meta)) continue;
      await tx`update events set text = ${text}, tool_input = ${toolInput === null ? null : JSON.stringify(toolInput)}::text::jsonb,
               meta = ${JSON.stringify(meta)}::text::jsonb where id = ${r.id}`;
      r.text = text;
      r.tool_input = toolInput;
      changed++;
    }
    await tx`delete from chunks where session_id = ${sessionId}`;
    const chunks = await storeChunks(tx, sessionId, rows.map((r: any) => ({
      seq: r.seq, ts: r.ts.toISOString(), kind: r.kind, text: r.text, toolName: r.tool_name, toolInput: r.tool_input,
    })), 0);
    return { events: changed, chunks };
  });
}
