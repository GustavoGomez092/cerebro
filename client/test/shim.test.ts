import { afterAll, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHIM = join(import.meta.dir, "../../plugin/bin/cerebro");
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function script(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/** A plugin bin/ dir holding a copy of the shim, plus a fake `uname` reporting `machine`. */
function layout(machine: string) {
  const root = mkdtempSync(join(tmpdir(), "cerebro-shim-"));
  dirs.push(root);
  const bin = join(root, "plugin", "bin");
  const fake = join(root, "fakebin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(fake);
  copyFileSync(SHIM, join(bin, "cerebro"));
  chmodSync(join(bin, "cerebro"), 0o755);
  script(join(fake, "uname"), `[ "$1" = "-m" ] && echo ${machine} || echo Darwin`);
  const run = (args: string[], stdin = "") =>
    Bun.spawnSync([join(bin, "cerebro"), ...args], {
      stdin: Buffer.from(stdin),
      env: { ...process.env, PATH: `${fake}:/usr/bin:/bin` },
    });
  return { bin, run };
}

test("the manifest and hooks.json wire every hook event to the shim", async () => {
  const plugin = join(import.meta.dir, "../../plugin");
  const manifest = await Bun.file(join(plugin, ".claude-plugin/plugin.json")).json();
  const clientPkg = await Bun.file(join(import.meta.dir, "../package.json")).json();
  expect(manifest.name).toBe("cerebro");
  expect(manifest.version).toBe(clientPkg.version);
  expect(manifest.userConfig.server_url).toMatchObject({ type: "string", required: true, default: "http://cerebro.home.lab" });
  expect(manifest.userConfig.token).toMatchObject({ type: "string", required: true, sensitive: true });

  const { hooks } = await Bun.file(join(plugin, "hooks/hooks.json")).json();
  expect(Object.keys(hooks).sort()).toEqual(["PreCompact", "SessionEnd", "SessionStart", "Stop"]);
  for (const [event, groups] of Object.entries(hooks) as [string, any[]][]) {
    expect(groups).toHaveLength(1);
    expect(groups[0].hooks).toEqual([{
      type: "command", command: "${CLAUDE_PLUGIN_ROOT}/bin/cerebro", args: ["hook", event], timeout: event === "SessionStart" ? 10 : 5,
    }]);
  }
});

test("shim runs the arch binary and is silent when it is missing", () => {
  for (const [machine, arch] of [["arm64", "arm64"], ["x86_64", "x64"]] as const) {
    const { bin, run } = layout(machine);
    script(join(bin, `cerebro-darwin-${arch}`), `echo "${arch} $*"; cat; exit 3`);
    const r = run(["hook", "Stop"], "from stdin");
    expect(r.stdout.toString()).toBe(`${arch} hook Stop\nfrom stdin`);
    expect(r.exitCode).toBe(3); // exec'd: the binary's own exit status comes through

    rmSync(join(bin, `cerebro-darwin-${arch}`));
    const missing = run(["hook", "Stop"], "{}");
    expect(missing.exitCode).toBe(0);
    expect(missing.stdout.toString()).toBe("");
    expect(missing.stderr.toString()).toBe("");
  }
});
