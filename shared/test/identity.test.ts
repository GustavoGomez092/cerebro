import { test, expect } from "bun:test";
import { normalizeRemote, pathIdentity } from "../src/identity";

test("remote spellings of the same repo normalise identically", () => {
  for (const u of ["git@github.com:Org/Repo.git", "https://github.com/org/repo", "ssh://git@github.com/org/repo.git/"])
    expect(normalizeRemote(u)).toBe("github.com/org/repo");
  expect(normalizeRemote("https://GitLab.com/A/B/")).toBe("gitlab.com/a/b");
  expect(normalizeRemote("https://user:pw@github.com/org/repo.git")).toBe("github.com/org/repo");
});

test("path identity is machine-specific", () => {
  expect(pathIdentity("mac-mini", "/Users/x/notes")).toBe("path:mac-mini:/Users/x/notes");
});
