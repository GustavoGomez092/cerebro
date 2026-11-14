import { test, expect } from "bun:test";
import { loadConfig } from "../src/config";

const base = { DATABASE_URL: "postgres://x", EMBED_URL: "http://cerebro-ollama:11434" };
const DIGEST = "790764642607" + "a".repeat(52);

test("EMBED_PRIMARY_URL is optional; unset or empty means no primary", () => {
  expect(loadConfig(base).embedPrimaryUrl).toBeNull();
  expect(loadConfig({ ...base, EMBED_PRIMARY_URL: "" }).embedPrimaryUrl).toBeNull();
  expect(loadConfig({ ...base, EMBED_PRIMARY_URL: "http://192.168.4.42:11434" }).embedPrimaryUrl).toBe("http://192.168.4.42:11434");
});

test("embedding URLs are validated at startup: http(s) only", () => {
  for (const bad of ["192.168.4.42:11434", "ftp://mac:11434", "not a url", "http://"]) {
    expect(() => loadConfig({ ...base, EMBED_PRIMARY_URL: bad })).toThrow(/EMBED_PRIMARY_URL/);
    expect(() => loadConfig({ ...base, EMBED_URL: bad })).toThrow(/EMBED_URL/);
  }
  expect(loadConfig({ ...base, EMBED_URL: "https://ollama.example:443/" }).embedUrl).toBe("https://ollama.example:443/");
});

test("EMBED_MODEL_DIGEST takes a 12-hex prefix or the full sha256 (optionally sha256:-prefixed), normalised to lower case", () => {
  expect(loadConfig(base).embedModelDigest).toBeNull();
  expect(loadConfig({ ...base, EMBED_MODEL_DIGEST: "" }).embedModelDigest).toBeNull();
  expect(loadConfig({ ...base, EMBED_MODEL_DIGEST: "790764642607" }).embedModelDigest).toBe("790764642607");
  expect(loadConfig({ ...base, EMBED_MODEL_DIGEST: DIGEST.toUpperCase() }).embedModelDigest).toBe(DIGEST);
  expect(loadConfig({ ...base, EMBED_MODEL_DIGEST: `sha256:${DIGEST}` }).embedModelDigest).toBe(DIGEST);
  for (const bad of ["7907646426", "79076464260z", "790764642607" + "a".repeat(10), "bge-m3"])
    expect(() => loadConfig({ ...base, EMBED_MODEL_DIGEST: bad })).toThrow(/EMBED_MODEL_DIGEST/);
});
