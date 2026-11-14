import type { SQL } from "bun";
import { mapStrings, redactSecrets, storable } from "@cerebro/shared";
import { storeChunks } from "./chunk-store";
import { invalidateStates, scopeKey } from "./summarise/state";

export interface RedactResult {
  /** Events changed. */
  events: number;
  /** Search chunks rebuilt (and queued for embedding). */
  chunks: number;
  /** The session's summaries changed (their embeddings dropped, so the summariser re-embeds them). */
  summaries: number;
  /** Project states scrubbed and marked for a rebuild. */
  states: number;
}

/**
 * Scrubs a session after a secret slipped through: applies the standard redaction plus an
 * optional extra pattern to every event, then rebuilds its search chunks (and their
 * embeddings) from the cleaned text. The session's summaries are scrubbed too (title, body, text; the
 * full-text index follows), and the embeddings of those that changed are deleted, so the summariser's
 * sweep re-embeds the cleaned text. Every project state whose text held a match is scrubbed, and those
 * states and the states of the scopes the changed summaries are in are invalidated, so they are rebuilt
 * from the cleaned summaries. All in one transaction.
 */
export async function redactSession(sql: SQL, sessionId: string, pattern?: string): Promise<RedactResult> {
  const extra = pattern ? new RegExp(pattern, "g") : null;
  const scrub = (s: string) => {
    const r = redactSecrets(s);
    return extra ? r.replace(extra, "[REDACTED:manual]") : r;
  };
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  return sql.begin(async (tx) => {
    const [s] = await tx`select cwd, meta from sessions where id = ${sessionId}`;
    if (s) await tx`update sessions set cwd = ${scrub(s.cwd)}, meta = ${JSON.stringify(mapStrings(s.meta, scrub))}::text::jsonb where id = ${sessionId}`;
    const rows = await tx`select id, seq, ts, kind, text, tool_name, tool_input, meta from events where session_id = ${sessionId} order by seq`;
    let changed = 0;
    for (const r of rows) {
      const text = scrub(r.text);
      const toolInput = r.tool_input == null ? null : mapStrings(r.tool_input, scrub);
      const meta = mapStrings(r.meta, scrub);
      if (text === r.text && same(toolInput, r.tool_input) && same(meta, r.meta)) continue;
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

    // Summaries carry the same conversation, as does every state they were folded into.
    const scopes = new Set<string>();
    let summaries = 0;
    for (const m of await tx`
      select id, title, body, text, client_id, project_id from summaries where session_id = ${sessionId} order by id for update`) {
      const title = storable(scrub(m.title));
      const body = mapStrings(m.body, (x: string) => storable(scrub(x)));
      const text = storable(scrub(m.text));
      if (title === m.title && text === m.text && same(body, m.body)) continue;
      await tx`update summaries set title = ${title}, body = ${JSON.stringify(body)}::text::jsonb, text = ${text} where id = ${m.id}`;
      await tx`delete from summary_embeddings where summary_id = ${m.id}`;
      if (m.client_id) scopes.add(scopeKey(m.client_id, m.project_id));
      summaries++;
    }
    let states = 0;
    for (const p of await tx`select scope, doc, text from project_states order by scope for update`) {
      const doc = mapStrings(p.doc, (x: string) => storable(scrub(x)));
      const text = storable(scrub(p.text));
      const dirtyText = text !== p.text || !same(doc, p.doc);
      if (dirtyText) await tx`update project_states set doc = ${JSON.stringify(doc)}::text::jsonb, text = ${text} where scope = ${p.scope}`;
      if (dirtyText || scopes.has(p.scope)) {
        scopes.add(p.scope);
        states++;
      }
    }
    await invalidateStates(tx, [...scopes]);
    return { events: changed, chunks, summaries, states };
  });
}
