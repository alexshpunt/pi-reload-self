import { writeFileSync } from "node:fs";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Replace the current runtime the way a deferred move does: queue from a tool, switch to a copy
 * of the same session from agent_settled, then continue from the fresh runtime. Load it before
 * the reload extension so its settle handler wins the race, as in the recorded Teleport overlap.
 */
export default function sessionReplacementFixture(pi: ExtensionAPI): void {
  let queued = false;
  pi.registerTool({
    name: "replace_session", label: "Replace session", description: "Queue a same-session runtime replacement.",
    parameters: Type.Object({}),
    async execute() {
      queued = true;
      return { content: [{ type: "text", text: "Session replacement queued." }], details: {} };
    },
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (!queued || !ctx.isIdle()) return;
    queued = false;
    pi.sendUserMessage("/replace-session-internal", { deliverAs: "followUp", expandPromptTemplates: true });
  });
  pi.registerCommand("replace-session-internal", {
    description: "Internal fixture command",
    async handler(_args, ctx) {
      const header = ctx.sessionManager.getHeader()!;
      const destination = SessionManager.create(ctx.cwd, undefined, { id: header.id }).getSessionFile()!;
      writeFileSync(destination, [header, ...ctx.sessionManager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n");
      await ctx.switchSession(destination, { withSession: async next => {
        await next.sendMessage({ customType: "replacement-continuation", content: "Session replaced; continue.", display: false },
          { triggerTurn: true, deliverAs: "followUp" });
      } });
    },
  });
}
