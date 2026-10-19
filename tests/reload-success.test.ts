import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";

import { encodeReloadPayload } from "../src/payload.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = join(root, "node_modules/@earendil-works/pi-coding-agent");
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const cliPath = join(packageDir, manifest.bin.pi);

interface ReloadRecord {
  type: "start" | "continuation";
  pid: number;
  sessionId: string;
  cwd?: string;
  text?: string;
  source?: string;
}

async function within<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Real reload did not complete within 10 seconds.")), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

test("a real RPC reload preserves the session and delivers its continuation exactly once without a model", {
  timeout: 20000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-reload-success-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const agentDir = join(directory, "agent");
  await mkdir(agentDir);
  const continuation = "fixture continuation consumed without a model request";
  const recordsPath = join(directory, "reload-events.jsonl");
  const records = async (): Promise<ReloadRecord[]> =>
    (await readFile(recordsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const client = new RpcClient({
    cliPath,
    cwd: directory,
    env: {
      PI_CODING_AGENT_DIR: agentDir,
      PROBE_RECORD_DIR: directory,
      RELOAD_CONTINUATION: continuation,
      PI_OFFLINE: "1",
    },
    provider: "startup-fixture",
    model: "startup-model",
    args: [
      "--no-session", "--offline", "--approve", "--no-extensions",
      "-e", join(root, "src/index.ts"),
      "-e", join(root, "tests/fixtures/startup-extension.ts"),
      "-e", join(root, "tests/fixtures/continuation-sink.ts"),
    ],
  });
  let agentStarts = 0;
  const unsubscribe = client.onEvent((event) => {
    if (event.type === "agent_start") agentStarts += 1;
  });
  let parentPid: number | undefined;
  try {
    await within(client.start());
    const before = await within(client.getState());
    const initial = await records();
    assert.equal(initial.length, 1);
    parentPid = initial[0].pid;
    assert.equal(initial[0].sessionId, before.sessionId);

    const disposition = await within(client.prompt(
      `/pi-reload-self-run ${encodeReloadPayload({ continuationPrompt: continuation })}`,
    ));
    assert.equal(disposition, "handled");
    await within((async () => {
      for (;;) {
        const events = await records();
        if (events.some((event) => event.type === "continuation")) return events;
        await delay(20);
      }
    })());
    const after = await within(client.getState());
    const observed = await records();
    assert.equal(after.sessionId, before.sessionId);
    assert.equal(after.sessionFile, undefined);
    assert.equal(after.pendingMessageCount, 0);
    assert.equal(after.isStreaming, false);
    const parentStarts = observed.filter((event) => event.type === "start" && event.pid === parentPid);
    assert.equal(parentStarts.length, 2);
    assert.ok(parentStarts.every((event) => event.sessionId === before.sessionId && event.cwd === directory));
    assert.ok(observed.some((event) => event.type === "start" && event.pid !== parentPid),
      "The reload must actually run its separate startup probe.");
    assert.deepEqual(observed.filter((event) => event.type === "continuation"), [{
      type: "continuation", pid: parentPid, sessionId: before.sessionId,
      text: continuation, source: "extension",
    }]);
    assert.equal(agentStarts, 0);
    assert.equal(existsSync(join(directory, "model-called")), false);
  } finally {
    unsubscribe();
    await client.stop();
  }
  assert.ok(parentPid);
  assert.throws(() => process.kill(parentPid, 0), { code: "ESRCH" });
});
