import { test, expect } from "bun:test";
import { redactSecrets } from "../src/redact";

test("known secret formats are redacted with a marker", () => {
  const cases: [string, string][] = [
    ["key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 end", "sk-ant"],
    ["export OPENAI_API_KEY=sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345", "sk-proj-ABCDEFGH"],
    ["token cbr_" + "a".repeat(43), "cbr_"],
    ["gh ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "ghp_"],
    ["aws AKIAIOSFODNN7EXAMPLE", "AKIA"],
    ["slack xoxb-1234567890-abcdefghijklmnop", "xoxb-"],
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij", "eyJhbGci"],
    ["postgres://app:hunter2secret@db:5432/x", "hunter2secret"],
    ["DB_PASSWORD=correct-horse-battery", "correct-horse"],
    ["-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXk"],
  ];
  for (const [input, secret] of cases) {
    const out = redactSecrets(input);
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED");
  }
});

test("ordinary text is left alone", () => {
  for (const s of ["the password field is required", "use token-based auth", "see https://example.com/path", "sk-learn is a library", "password: <hidden>"]) {
    expect(redactSecrets(s)).toBe(s);
  }
  expect(redactSecrets("postgres://app@db/x")).toBe("postgres://app@db/x");
});
