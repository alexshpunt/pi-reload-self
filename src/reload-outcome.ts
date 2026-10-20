import type { ExtensionAPI, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { StartupProbeResult } from "./startup-probe.ts";

/** Real execution ownership captured before deferring a tool-initiated reload. */
export interface ReloadOrigin {
  toolCallId: string;
  parentToolCallId: string;
  sessionId: string;
  anchorId: string | null;
}

/**
 * Full outcome for model delivery; the persisted visible entry contains only the summary.
 * A cancelled request was invalidated when its runtime shut down for `cause` before it reloaded.
 */
export type ReloadOutcome = ReloadOrigin & (
  | { status: "reloaded" | "blocked"; probe: StartupProbeResult }
  | { status: "cancelled"; cause: SessionShutdownEvent["reason"] }
);

const ENTRY_TYPE = "pi-reload-self-outcome";
const SUMMARIES: Record<ReloadOutcome["status"], string> = {
  reloaded: "Pi reloaded. Continuing with the requested prompt.",
  blocked: "Reload blocked: the final startup check failed. Pi was not reloaded; fix the startup error before retrying.",
  cancelled: "Reload cancelled: the session runtime was replaced before this reload ran. Its continuation was not sent.",
};
const COLORS = { reloaded: "success", blocked: "error", cancelled: "warning" } as const;

function agentText(outcome: ReloadOutcome): string {
  const lines = outcome.status === "cancelled"
    ? [`Cause: the runtime shut down for "${outcome.cause}" while the reload was still queued or being checked.`,
      "Call pi_extension_dev_reload_self again if a reload is still needed."]
    : [`CWD: ${outcome.probe.cwd}`, ...outcome.probe.diagnostics];
  return [SUMMARIES[outcome.status], ...lines].join("\n").trimEnd();
}

/** Register a durable, searchable summary without adding model context. */
export function registerReloadOutcomeRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<{ status: ReloadOutcome["status"]; parentToolCallId: string; summary: string }>(
    ENTRY_TYPE,
    (entry, _options, theme) => new Text(theme.fg(COLORS[entry.data!.status], entry.data!.summary), 0, 0),
  );
}

/** Keep concise linked presentation independent from complete, hidden model delivery. */
export function publishReloadOutcome(pi: ExtensionAPI, outcome: ReloadOutcome): void {
  const summary = SUMMARIES[outcome.status];
  pi.appendEntry(ENTRY_TYPE, { status: outcome.status, parentToolCallId: outcome.parentToolCallId, summary });
  pi.sendMessage({
    customType: "pi-reload-self", display: false, content: agentText(outcome), details: outcome,
  }, outcome.status === "blocked" ? { triggerTurn: true, deliverAs: "followUp" } : undefined);
}
