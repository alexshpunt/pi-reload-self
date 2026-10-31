import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getInitialLaunchCwd } from "../src/runtime-reload.ts";

test("reloads preserve the original launch directory after process.chdir", async () => {
  const original = process.cwd();
  const launchCwd = getInitialLaunchCwd();
  const directory = mkdtempSync(join(tmpdir(), "pi-reload-origin-"));
  try {
    process.chdir(directory);
    const freshModule = "../src/runtime-reload.ts?reloaded";
    const reloaded = await import(freshModule);
    assert.equal(reloaded.getInitialLaunchCwd(), launchCwd);
  } finally {
    process.chdir(original);
    rmSync(directory, { recursive: true, force: true });
  }
});
