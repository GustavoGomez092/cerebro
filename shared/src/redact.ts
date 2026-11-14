/**
 * Secret redaction shared by the client plugin (before upload) and the server (at ingest,
 * as defence in depth). Replaces each secret with `[REDACTED:<kind>]` so the fact that a
 * secret was there survives.
 */
const RULES: [RegExp, string][] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[REDACTED:private-key]"],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, "[REDACTED:anthropic-key]"],
  [/\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED:api-key]"],
  [/\bcbr_[A-Za-z0-9_-]{40,}/g, "[REDACTED:cerebro-token]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g, "[REDACTED:github-token]"],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}/g, "[REDACTED:github-token]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED:aws-key]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED:slack-token]"],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{20,}/gi, "$1 [REDACTED:bearer]"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(@)/gi, "$1[REDACTED:password]$2"],
  [/\b([A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*[=:]\s*)(["']?)([^\s"'[]{8,})\2/g, "$1$2[REDACTED:secret]$2"],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  return out;
}
