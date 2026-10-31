import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assistantMessage, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

for (const scenario of ["direct", "nested"] as const) {
  test(`real Pi ${scenario} reload queued before a session replacement is cancelled at its call once`, { timeout: 45000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), "pi-replaced-reload-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const result = await new PiIntegrationTest({
      testName: `replaced-reload-${scenario}`,
      artifactsDir: testArtifactsDir(import.meta.filename, join(root, "tmp/test-runs")),
      cwd: directory, isolateUserResources: true, rawMode: false,
      extensions: [join(root, "tests/fixtures/session-replacement.ts"), join(root, "tests/fixtures/delayed-reload.ts"),
        ...(process.env.RELOAD_STEREO_EXTENSION ? [process.env.RELOAD_STEREO_EXTENSION] : [])],
      tools: ["replace_session", "reload_pi", "nested_reload"],
      environment: { RELOAD_RECORD_DIR: directory, RELOAD_DELAYED_CASE: "direct", PI_OFFLINE: "1" },
      conversation: [
        assistantMessage([toolCall({ id: "replace", name: "replace_session", arguments: {} })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({
          id: "visible-root", name: scenario === "nested" ? "nested_reload" : "reload_pi",
          arguments: scenario === "nested" ? {} : { next_action: "CONTINUATION_EXACT_TEXT" },
        })], { stopReason: "toolUse" }),
        assistantMessage([text("The reload has only been scheduled.")]),
        assistantMessage([text("The replacement finished and the reload was cancelled.")]),
      ],
    }).run("Replace the session, then schedule a reload before it happens.");
    assert.match(getToolResultText(result, "visible-root"), /scheduled/, "the scheduling receipt stays unchanged");
    const branch = result.traceEvents.filter(event => event.type === "session_snapshot").at(-1)!.branch as Array<any>;
    assert.equal(branch.filter(entry => entry.type === "custom_message" && entry.customType === "replacement-continuation").length, 1);
    const outcomes = branch.filter(entry => entry.type === "custom" && entry.customType === "pi-reload-self-outcome");
    assert.deepEqual(outcomes.map(entry => [entry.data.parentToolCallId, entry.data.status]), [["visible-root", "cancelled"]]);
    assert.ok(branch.indexOf(outcomes[0]) > branch.findIndex(entry => entry.type === "message" && entry.message.toolCallId === "visible-root"),
      "linked display must not rewrite chronological history");
    const deliveries = branch.filter(entry => entry.type === "custom_message" && entry.customType === "pi-reload-self");
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].display, false);
    assert.equal(deliveries[0].details.toolCallId, scenario === "nested" ? "visible-root/1" : "visible-root");
    const lastRequest = JSON.stringify(result.providerRequests.at(-1));
    assert.equal(count(lastRequest, "Reload cancelled"), 1);
    assert.equal(count(lastRequest, "Pi reloaded."), 0);
    const records = (await readFile(join(directory, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(records.filter(event => event.type === "start" && event.reason === "resume").length, 1);
    assert.equal(records.filter(event => event.type === "start" && event.reason === "reload").length, 0, "the cancelled request never reloads");
    assert.equal(records.filter(event => event.type === "input" && event.text === "CONTINUATION_EXACT_TEXT").length, 0,
      "its continuation never runs");
    const rendered = await readFile(result.artifacts.tuiRenderedOutput, "utf8");
    assert.equal(count(rendered, "Reload cancelled"), 1, "the hidden delivery must not add a second visible card");
  });
}
