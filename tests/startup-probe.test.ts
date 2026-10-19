import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { probeStartup } from "../src/startup-probe.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = join(root, "node_modules/@earendil-works/pi-coding-agent");
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const cliPath = join(packageDir, manifest.bin.pi);
const fixture = join(root, "tests/fixtures/startup-extension.ts");

async function workspace(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "pi-reload-probe-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cwd = join(dir, "project");
  const agentDir = join(dir, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PROBE_RECORD_DIR: dir,
    PROBE_SENTINEL: "inherited-fixture-value",
  };
  const args = ["--mode", "rpc", "--no-session", "--offline", "--approve", "--no-extensions",
    "-e", fixture, "--provider", "startup-fixture", "--model", "startup-model"];
  return { dir, cwd, agentDir, env, args };
}

function assertStopped(pid: number) {
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

test("healthy RPC startup checks the target CWD without calling a model and shuts down", async (t) => {
  const setup = await workspace(t);
  const result = await probeStartup({ ...setup, cliPath });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.cwd, setup.cwd);
  const started = JSON.parse(await readFile(join(setup.dir, "started.json"), "utf8"));
  assert.equal(started.cwd, setup.cwd);
  assert.equal(started.sentinel, "inherited-fixture-value");
  assert.equal(existsSync(join(setup.dir, "model-called")), false);
  assert.equal(await readFile(join(setup.dir, "shutdown"), "utf8"), "done");
  assertStopped(started.pid);
  assert.deepEqual(await import("node:fs/promises").then((fs) => fs.readdir(setup.cwd)), []);
});

for (const [scenario, marker] of [
  ["load-error", "fixture-load-failure"],
  ["handler-error", "fixture-start-failure"],
  ["notify-error", "fixture-notify-error"],
]) {
  test(`startup blocks on ${scenario} rather than accepting a live RPC process`, async (t) => {
    const setup = await workspace(t);
    const result = await probeStartup({ ...setup, cliPath, env: { ...setup.env, PROBE_CASE: scenario } });
    assert.equal(result.ok, false);
    assert.match(result.diagnostics.join("\n"), new RegExp(marker));
    if (existsSync(join(setup.dir, "started.json"))) {
      assertStopped(JSON.parse(await readFile(join(setup.dir, "started.json"), "utf8")).pid);
    }
  });
}

for (const [scenario, marker] of [
  ["stderr-warning", "fixture-stderr-warning"],
  ["notify-warning", "fixture-notify-warning"],
]) {
  test(`startup reports ${scenario} without blocking reload`, async (t) => {
    const setup = await workspace(t);
    const result = await probeStartup({ ...setup, cliPath, env: { ...setup.env, PROBE_CASE: scenario } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(result.diagnostics.join("\n"), new RegExp(marker));
  });
}

test("a startup timeout kills the stalled probe", async (t) => {
  const setup = await workspace(t);
  const result = await probeStartup({
    ...setup, cliPath, timeoutMs: 5000, env: { ...setup.env, PROBE_CASE: "stall" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "timeout");
  assertStopped(JSON.parse(await readFile(join(setup.dir, "started.json"), "utf8")).pid);
});

test("cancelling a started probe kills it and reports cancellation", async (t) => {
  const setup = await workspace(t);
  const controller = new AbortController();
  const resultPromise = probeStartup({
    ...setup, cliPath, signal: controller.signal, env: { ...setup.env, PROBE_CASE: "stall" },
  });
  const deadline = Date.now() + 10000;
  while (!existsSync(join(setup.dir, "started.json")) && Date.now() < deadline) await delay(25);
  controller.abort();
  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.reason, "cancelled");
  assertStopped(JSON.parse(await readFile(join(setup.dir, "started.json"), "utf8")).pid);
});

for (const source of ["global", "project"]) {
  test(`startup loads ${source} settings from the target session directories`, async (t) => {
    const setup = await workspace(t);
    const settingsDir = source === "global" ? setup.agentDir : join(setup.cwd, ".pi");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(join(settingsDir, "settings.json"), JSON.stringify({ extensions: [fixture] }));
    const args = setup.args.filter((arg, i, all) =>
      arg !== "--no-extensions" && arg !== "-e" && all[i - 1] !== "-e");
    const result = await probeStartup({ ...setup, cliPath, args });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(JSON.parse(await readFile(join(setup.dir, "started.json"), "utf8")).cwd, setup.cwd);
  });
}

test("a ready probe with a slow shutdown is stopped without being called a startup failure", async (t) => {
  const setup = await workspace(t);
  const result = await probeStartup({ ...setup, cliPath, env: { ...setup.env, PROBE_CASE: "slow-shutdown" } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assertStopped(JSON.parse(await readFile(join(setup.dir, "started.json"), "utf8")).pid);
});

test("cleanup has its own deadline when an escaped descendant holds the output pipes", { timeout: 10000 }, async (t) => {
  const setup = await workspace(t);
  const pidFile = join(setup.dir, "descendant");
  t.after(async () => {
    if (existsSync(pidFile)) {
      try { process.kill(-Number(await readFile(pidFile, "utf8")), "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  });
  const result = await probeStartup({
    ...setup, cliPath: join(root, "tests/fixtures/hanging-cleanup.mjs"),
    env: { ...setup.env, DESCENDANT_PID_FILE: pidFile },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "cleanup-timeout");
});