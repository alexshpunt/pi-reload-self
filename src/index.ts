import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { createProbeLaunch } from "./probe-launch.ts";
import { probeStartup, type StartupProbeResult } from "./startup-probe.ts";

import {
  decodeReloadPayload,
  encodeReloadPayload,
  extractReloadPayloadToken,
  validateContinuationPrompt,
} from "./payload.ts";
import {
  clearPendingReloadCommand,
  hasPendingReloadCommand,
  getInitialLaunchCwd,
  storeContinuationPrompt,
  storePendingReloadCommand,
  takeContinuationPrompt,
  takePendingReloadCommand,
} from "./runtime-reload.ts";

const COMMAND_NAME = "pi-reload-self-run";
const TOOL_NAME = "pi_extension_dev_reload_self";

/** Startup gate shared by the tool and direct command paths. */
export type StartupCheck = (ctx: ExtensionContext, signal: AbortSignal) => Promise<StartupProbeResult>;

function probeText(result: StartupProbeResult): string {
  const status = result.ok ? "Startup check passed" : "Reload blocked: startup check failed";
  const diagnostics = result.diagnostics.join("\n");
  return `${status}.\nCWD: ${result.cwd}\n${diagnostics}`.trimEnd();
}

/** Register reload orchestration around an isolated, cancellable startup check. */
export async function registerReloadSelf(pi: ExtensionAPI, check: StartupCheck): Promise<void> {
  let lifetime = new AbortController();
  let generation = 0;
  let checking = false;
  const checkStartup: StartupCheck = async (ctx, signal) => {
    const currentGeneration = generation;
    const cwd = ctx.cwd;
    const sessionSignal = lifetime.signal;
    let result: StartupProbeResult;
    try {
      result = await check(ctx, AbortSignal.any([signal, sessionSignal]));
    } catch (error) {
      result = { ok: false, cwd, reason: "process-error", diagnostics: [error instanceof Error ? error.message : String(error)] };
    }
    if (currentGeneration !== generation || signal.aborted || sessionSignal.aborted) {
      return { ok: false, cwd, reason: "cancelled", diagnostics: ["Startup check cancelled: session changed or operation aborted."] };
    }
    return result;
  };

  pi.on("session_shutdown", async () => { lifetime.abort(); });
  pi.on("session_start", async (_event, _ctx) => {
    lifetime.abort();
    lifetime = new AbortController();
    generation += 1;
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

      if (checking) {
        ctx.ui?.notify("pi-reload-self: a startup check is already running", "warning");
        return;
      }
      checking = true;
      let result: StartupProbeResult;
      const commandGeneration = generation;
      try {
        // Recheck immediately before reload: files or CWD may have changed while settling.
        result = await checkStartup(ctx, ctx.signal ?? new AbortController().signal);
      } finally {
        checking = false;
      }
      if (commandGeneration !== generation || lifetime.signal.aborted) return;
      ctx.ui?.notify(probeText(result), result.ok ? "info" : "error");
      if (!result.ok) {
        pi.sendMessage({ customType: "pi-reload-self", content: probeText(result), display: false, details: result });
      }
      if (!result.ok || !ctx.isIdle()) return;

      storeContinuationPrompt(continuationPrompt);
      try {
        await ctx.reload();
      } catch (error) {
        takeContinuationPrompt();
        throw error;
      }
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
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
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
      if (checking || hasPendingReloadCommand()) {
        return {
          content: [{ type: "text", text: "Reload already queued or being checked; the existing continuation is unchanged." }],
          details: { queued: false, reason: "already-queued" },
        };
      }
      checking = true;
      let probe: StartupProbeResult;
      try {
        probe = await checkStartup(ctx, signal ?? ctx.signal ?? new AbortController().signal);
      } finally {
        checking = false;
      }
      if (!probe.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: probeText(probe) }],
          details: { queued: false, reason: "startup-check-failed", probe },
        };
      }
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
              `${probeText(probe)}\nPi reload is scheduled for agent_settled and will be rechecked immediately before reload.`,
          },
        ],
        details: { queued: true, reason: "scheduled-after-settled" },
      };
    },
  });
}

/** Load the real CLI startup gate for normal Pi extension use. */
export default async function reloadSelfExtension(pi: ExtensionAPI): Promise<void> {
  const launchCwd = getInitialLaunchCwd();
  await registerReloadSelf(pi, (ctx, signal) => probeStartup({ ...createProbeLaunch(ctx, launchCwd), signal }));
}