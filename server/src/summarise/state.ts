import type { SQL } from "bun";

/** The state scope a summary belongs to: its project when it has one, else its client. */
export function scopeKey(clientId: string, projectId: string | null): string {
  return projectId ? `project:${projectId}` : `client:${clientId}`;
}

/**
 * Flags scopes for a state update, creating an empty state row for a scope that has none yet.
 * Keys naming an unknown client or project are ignored.
 */
export async function markScopesDirty(sql: SQL, keys: string[]): Promise<void> {
  for (const key of new Set(keys)) {
    const [kind, id] = key.split(":", 2);
    if (!id) continue;
    if (kind === "project") {
      await sql`
        insert into project_states (scope, client_id, project_id, doc, text, dirty)
        select ${key}, p.client_id, p.id, '{}'::jsonb, '', true from projects p where p.id::text = ${id}
        on conflict (scope) do update set dirty = true`;
    } else if (kind === "client") {
      await sql`
        insert into project_states (scope, client_id, project_id, doc, text, dirty)
        select ${key}, c.id, null, '{}'::jsonb, '', true from clients c where c.id::text = ${id}
        on conflict (scope) do update set dirty = true`;
    }
  }
}
