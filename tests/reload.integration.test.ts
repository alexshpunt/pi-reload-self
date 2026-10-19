import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall,
} from "pi-coding-agent-test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("a real Pi tool call blocks a broken startup and leaves the original session usable", { timeout: 45000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-reload-integration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const agentDir = join(directory, "agent");
  await mkdir(agentDir);
  const result = await new PiIntegrationTest({
    testName: "reload-blocks-startup-error",
    artifactsDir: testArtifactsDir(import.meta.filename, join(root, "tmp/test-runs")),
    cwd: directory,
    isolateUserResources: true,
    rawMode: false,
    extensions: [join(root, "src/index.ts"), join(root, "tests/fixtures/arm-startup-failure.ts")],
    tools: ["arm_startup_failure", "pi_extension_dev_reload_self"],
    environment: { PI_CODING_AGENT_DIR: agentDir, RELOAD_FIXTURE_DIR: directory, PI_OFFLINE: "1" },
    conversation: [
      assistantMessage([toolCall({ id: "arm", name: "arm_startup_failure", arguments: {} })], { stopReason: "toolUse" }),
      assistantMessage([toolCall({
        id: "reload", name: "pi_extension_dev_reload_self",
        arguments: { continuation_prompt: "THIS_CONTINUATION_MUST_NOT_RUN", confirm_state_loss: true },
      })], { stopReason: "toolUse" }),
      assistantMessage([text("The original session is still usable.")]),
    ],
  }).run("Arm the startup failure and attempt a reload.");
  assert.equal(getToolExecution(result, "reload").isError, true);
  const output = getToolResultText(result, "reload");
  assert.match(output, /fixture-armed-startup-failure/);
  assert.ok(output.includes(`CWD: ${directory}`));
  assert.equal(result.providerRequests.length, 3);
  assert.ok(result.state);
  assert.equal(result.state.hasPendingMessages, false);
  assert.equal((await readFile(join(directory, "starts"), "utf8")).trim().split("\n").length, 1);
  const rendered = await readFile(result.artifacts.tuiRenderedOutput, "utf8");
  assert.match(rendered, /Reload blocked/);
  assert.match(rendered, /The original session is still usable/);
});
