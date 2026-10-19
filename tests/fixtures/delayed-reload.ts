import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { registerReloadSelf } from "../../src/index.ts";

/** Exercise real command dispatch, nested execution and runtime replacement with a controlled startup gate. */
export default async function delayedReloadFixture(pi: ExtensionAPI): Promise<void> {
  let checks = 0;
  await registerReloadSelf(pi, async ctx => {
    const ok = ++checks === 1 || process.env.RELOAD_DELAYED_CASE !== "blocked";
    return { ok, cwd: ctx.cwd, reason: ok ? "ready" : "startup-error", diagnostics: ok ? [] : ["delayed-probe-diagnostic-marker"] };
  });
  const record = (data: unknown) => appendFileSync(join(process.env.RELOAD_RECORD_DIR!, "events.jsonl"), JSON.stringify(data) + "\n");
  pi.on("session_start", (event, ctx) => record({ type: "start", reason: event.reason, sessionId: ctx.sessionManager.getSessionId() }));
  pi.on("input", event => { record({ type: "input", text: event.text }); });
  pi.registerTool({
    name: "nested_reload", label: "Nested reload", description: "Call the reload tool through the real nested execution API.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      const outcome = await ctx.executeTool("pi_extension_dev_reload_self", {
        continuation_prompt: "CONTINUATION_EXACT_TEXT", confirm_state_loss: true,
      }, { signal });
      return { ...outcome.result, isError: outcome.isError };
    },
  });
}
