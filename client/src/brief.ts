import type { Binding, SessionView } from "@cerebro/shared";

export const BRIEF_MAX_CHARS = 1500;
const MAX_SESSIONS = 5;

const TOOLS_LINE =
  "Recall: cerebro_search finds past conversations, cerebro_sessions lists sessions by date, cerebro_read opens a session's conversation.";

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + "…" : s);

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? clip(iso, 30) : `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The SessionStart context for a bound folder: binding, recent sessions, upload queue, problems, recall tools. ≤ 1500 chars. */
export function buildBrief(
  binding: Binding,
  scopeName: string,
  recent: SessionView[],
  queue: { pending: number; quarantined: number },
  problems: string[],
): string {
  const folder = binding.repo + (binding.subpath ? `/${binding.subpath}` : "");
  const lines = [`Cerebro memory is on for this folder: bound to ${clip(scopeName, 120)} (${clip(folder, 200)}).`];

  const where = binding.projectId ? "this project" : binding.clientId ? "this client" : "all clients";
  if (recent.length === 0) lines.push(`No sessions recorded yet in ${where}.`);
  else {
    lines.push(`Recent sessions in ${where}:`);
    for (const s of recent.slice(0, MAX_SESSIONS)) {
      lines.push(`- ${when(s.startedAt)} on ${clip(s.machine, 60)}${s.imported ? " (imported)" : ""}`);
    }
  }

  if (queue.pending > 0) lines.push(`${queue.pending} event${queue.pending === 1 ? "" : "s"} from this Mac waiting to upload.`);
  if (queue.quarantined > 0) {
    lines.push(`Problem: ${queue.quarantined} event${queue.quarantined === 1 ? " was" : "s were"} rejected by the server and set aside (see cerebro status).`);
  }
  for (const p of problems) lines.push(`Problem: ${clip(p, 300)}`);

  const room = BRIEF_MAX_CHARS - TOOLS_LINE.length - 1;
  return clip(lines.join("\n"), room) + "\n" + TOOLS_LINE;
}
