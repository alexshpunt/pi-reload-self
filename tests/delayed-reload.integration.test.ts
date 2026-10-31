import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assistantMessage, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const scenario of ["direct", "nested", "blocked"] as const) {
  test(`real Pi ${scenario} reload retains ownership and delivers the delayed outcome once`, { timeout: 45000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), "pi-delayed-reload-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const result = await new PiIntegrationTest({
      testName: `delayed-reload-${scenario}`,
      artifactsDir: testArtifactsDir(import.meta.filename, join(root, "tmp/test-runs")),
      cwd: directory, isolateUserResources: true, rawMode: false,
      extensions: [join(root, "tests/fixtures/delayed-reload.ts"),
        ...(process.env.RELOAD_STEREO_EXTENSION ? [process.env.RELOAD_STEREO_EXTENSION] : [])],
      tools: ["reload_pi", "nested_reload"],
      environment: { RELOAD_RECORD_DIR: directory, RELOAD_DELAYED_CASE: scenario, PI_OFFLINE: "1" },
      conversation: [
        assistantMessage([toolCall({
          id: "visible-root", name: scenario === "nested" ? "nested_reload" : "reload_pi",
          arguments: scenario === "nested" ? {} : { next_action: "CONTINUATION_EXACT_TEXT" },
        })], { stopReason: "toolUse" }),
        assistantMessage([text("The reload has only been scheduled.")]),
        assistantMessage([text("The delayed outcome was received.")]),
      ],
    }).run("Schedule the reload, then wait for its real outcome.");
    assert.match(getToolResultText(result, "visible-root"), /scheduled/);
    const snapshots = result.traceEvents.filter(event => event.type === "session_snapshot");
    const branch = snapshots.at(-1)!.branch as Array<any>;
    const outcomes = branch.filter(entry => entry.type === "custom" && entry.customType === "pi-reload-self-outcome");
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].data.parentToolCallId, "visible-root");
    assert.equal(outcomes[0].data.status, scenario === "blocked" ? "blocked" : "reloaded");
    assert.ok(branch.indexOf(outcomes[0]) > branch.findIndex(entry => entry.type === "message" && entry.message.role === "toolResult"),
      "linked display must not rewrite chronological history");
    const deliveries = branch.filter(entry => entry.type === "custom_message" && entry.customType === "pi-reload-self");
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].display, false);
    assert.equal(deliveries[0].details.toolCallId, scenario === "nested" ? "visible-root/1" : "visible-root");
    const lastRequest = JSON.stringify(result.providerRequests.at(-1));
    assert.equal(lastRequest.split(scenario === "blocked" ? "delayed-probe-diagnostic-marker" : "Pi reloaded.").length - 1, 1);
    const records = (await readFile(join(directory, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(records.filter(event => event.type === "start" && event.reason === "reload").length, scenario === "blocked" ? 0 : 1);
    assert.equal(records.filter(event => event.type === "input" && event.text === "CONTINUATION_EXACT_TEXT").length, scenario === "blocked" ? 0 : 1);
    const rendered = await readFile(result.artifacts.tuiRenderedOutput, "utf8");
    assert.match(rendered, scenario === "blocked" ? /Reload blocked/ : /Pi reloaded/);
    assert.doesNotMatch(rendered, /delayed-probe-diagnostic-marker/);
    assert.equal(rendered.split(scenario === "blocked" ? "Reload blocked" : "Pi reloaded").length - 1, 1,
      "the hidden delivery must not add a second visible card");
  });
}
