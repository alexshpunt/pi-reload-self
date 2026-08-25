import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  decodeReloadPayload,
  encodeReloadPayload,
  extractReloadPayloadToken,
  validateContinuationPrompt,
} from "./payload.ts";
import {
  clearPendingReloadCommand,
  storeContinuationPrompt,
  storePendingReloadCommand,
  takeContinuationPrompt,
  takePendingReloadCommand,
} from "./runtime-reload.ts";

const COMMAND_NAME = "pi-reload-self-run";
const TOOL_NAME = "pi_extension_dev_reload_self";

export default async function reloadSelfExtension(pi: ExtensionAPI): Promise<void> {
  pi.on("session_start", async (_event, _ctx) => {
    // A pending command belongs to the run that created it. If the session is
    // replaced or reloaded before that run settles, do not carry it forward.
    clearPendingReloadCommand();

    const continuationPrompt = takeContinuationPrompt();
    if (continuationPrompt) {
      pi.sendUserMessage(continuationPrompt, { deliverAs: "followUp" });
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!ctx.isIdle()) return;

    const command = takePendingReloadCommand();
    if (!command) return;

    // This is intentionally sent only from agent_settled. Pi expands and
    // dispatches slash commands before queueing messages, so sending from the
    // tool would invoke ctx.reload() while that tool's run is still active.
    pi.sendUserMessage(command, { deliverAs: "followUp", expandPromptTemplates: true });
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Internal command used by pi_extension_dev_reload_self to reload Pi and continue",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      let continuationPrompt: string;

      try {
        continuationPrompt = decodeReloadPayload(extractReloadPayloadToken(args, COMMAND_NAME)).continuationPrompt;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui?.notify(`pi-reload-self: ${message}`, "error");
        return;
      }

      if (!ctx.isIdle()) {
        ctx.ui?.notify("pi-reload-self: wait for the current response to finish before reloading", "warning");
        return;
      }

      storeContinuationPrompt(continuationPrompt);
      await ctx.reload();
      return;
    },
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Reload Pi and Continue",
    description:
      "Reload Pi extensions, skills, prompts, and themes, then continue with a provided prompt. WARNING: reload may reset extension/module in-memory state, hot-loaded resources, and other extension-maintained runtime state. Only call this when the user requested a reload or extension development changes require it. Requires confirm_state_loss: true.",
    promptSnippet:
      "Reload Pi extensions/resources and continue afterward; requires explicit state-loss confirmation.",
    promptGuidelines: [
      "Use pi_extension_dev_reload_self only when the user explicitly asks to reload Pi or when extension development changes need to be reloaded.",
      "Before calling pi_extension_dev_reload_self, set confirm_state_loss to true only if you accept that reload may reset extension/module in-memory state and extension-maintained runtime state.",
    ],
    parameters: Type.Object({
      continuation_prompt: Type.String({
        description: "Non-empty prompt to send to the agent after Pi reloads.",
      }),
      confirm_state_loss: Type.Boolean({
        description:
          "Must be true. Confirms acceptance that reload can reset extension/module in-memory state and extension-maintained runtime state.",
      }),
    }),
    async execute(_toolCallId, params) {
      if (!params.confirm_state_loss) {
        return {
          content: [
            {
              type: "text",
              text:
                "Reload not queued. pi_extension_dev_reload_self requires confirm_state_loss: true because reload may reset extension/module in-memory state and extension-maintained runtime state.",
            },
          ],
          details: { queued: false, reason: "missing-confirmation" },
        };
      }

      const continuationPrompt = validateContinuationPrompt(params.continuation_prompt);
      const payload = encodeReloadPayload({ continuationPrompt });
      const command = `/${COMMAND_NAME} ${payload}`;

      if (!storePendingReloadCommand(command)) {
        return {
          content: [
            {
              type: "text",
              text: "Reload already queued; the existing continuation will run after Pi settles.",
            },
          ],
          details: { queued: false, reason: "already-queued" },
        };
      }

      return {
        content: [
          {
            type: "text",
            text:
              "Pi reload is scheduled for the agent_settled event. The encoded command will then dispatch and the provided continuation prompt will be sent by the reloaded extension runtime.",
          },
        ],
        details: { queued: true, reason: "scheduled-after-settled" },
      };
    },
  });
}
