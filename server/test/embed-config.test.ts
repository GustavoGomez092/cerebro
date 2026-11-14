import { test, expect } from "bun:test";
import { loadConfig } from "../src/config";

const base = { DATABASE_URL: "postgres://x", EMBED_URL: "http://cerebro-ollama:11434" };
const DIGEST = "790764642607" + "a".repeat(52);

test("EMBED_MACHINE_URLS is optional; unset or empty means no per-machine endpoints", () => {
  expect(loadConfig(base).embedMachineUrls).toEqual({});
  expect(loadConfig({ ...base, EMBED_MACHINE_URLS: "" }).embedMachineUrls).toEqual({});
  expect(loadConfig({ ...base, EMBED_MACHINE_URLS: " " }).embedMachineUrls).toEqual({});
});

test("EMBED_MACHINE_URLS maps machine-token names to their Ollama", () => {
  const base2 = { ...base, EMBED_MODEL_DIGEST: "790764642607" };
  expect(loadConfig({ ...base2, EMBED_MACHINE_URLS: "mac-mini=http://192.168.4.42:11434" }).embedMachineUrls)
    .toEqual({ "mac-mini": "http://192.168.4.42:11434" });
  expect(loadConfig({ ...base2, EMBED_MACHINE_URLS: " mac-mini = http://192.168.4.42:11434 , macbook-pro=http://192.168.4.45:11434/ ," }).embedMachineUrls)
    .toEqual({ "mac-mini": "http://192.168.4.42:11434", "macbook-pro": "http://192.168.4.45:11434/" });
});

test("EMBED_MACHINE_URLS is validated at startup: name=url pairs, http(s) URLs, each machine once", () => {
  for (const bad of ["mac-mini", "=http://x:1", "mac-mini=", "mac-mini=192.168.4.42:11434", "mac-mini=ftp://x:1",
    "a=http://x:1,a=http://y:1", "a=http://x:1;b=http://y:1"])
    expect(() => loadConfig({ ...base, EMBED_MACHINE_URLS: bad }), bad).toThrow(/EMBED_MACHINE_URLS/);
});

test("EMBED_URL is validated at startup: http(s) only", () => {
  for (const bad of ["192.168.4.42:11434", "ftp://mac:11434", "not a url", "http://"])
    expect(() => loadConfig({ ...base, EMBED_URL: bad })).toThrow(/EMBED_URL/);
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

test("EMBED_MODEL_DIGEST is required whenever EMBED_MACHINE_URLS maps a machine", () => {
  expect(() => loadConfig({ ...base, EMBED_MACHINE_URLS: "mac-mini=http://192.168.4.42:11434" })).toThrow(/EMBED_MODEL_DIGEST is required/);
  expect(loadConfig({ ...base, EMBED_MACHINE_URLS: "mac-mini=http://192.168.4.42:11434", EMBED_MODEL_DIGEST: "790764642607" }).embedModelDigest)
    .toBe("790764642607");
  expect(loadConfig({ ...base, EMBED_MACHINE_URLS: "" }).embedModelDigest).toBeNull(); // no map, no digest needed
});
