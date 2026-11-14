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

test("ordinary configuration and code is not mistaken for secrets", () => {
  for (const s of [
    "const API_KEY = process.env.API_KEY",
    "TOKEN_ENDPOINT=https://auth.example.com/oauth/token",
    "GITHUB_TOKEN_URL='https://github.com/login/oauth'",
    "DB_PASSWORD_FILE=/run/secrets/db_password",
    "MAX_TOKENS: 100000000",
    "API_KEY=${API_KEY}",
    "SECRET_NAME=my_secret_name",
    'class="sk-spinner-fading-circle-large"',
    "import sk-learn-preprocessing-pipeline",
  ]) expect(redactSecrets(s)).toBe(s);
});

test("real-looking env secrets are still redacted", () => {
  expect(redactSecrets("DB_PASSWORD=correct-horse-battery")).toContain("[REDACTED");
  expect(redactSecrets("API_KEY=9f8a7b6c5d4e3f2a1b0c")).toContain("[REDACTED");
  expect(redactSecrets("export STRIPE_SECRET_KEY='rk_live_51H8abcdEFGH'")).toContain("[REDACTED");
});
