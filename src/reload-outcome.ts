import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { StartupProbeResult } from "./startup-probe.ts";

/** Real execution ownership captured before deferring a tool-initiated reload. */
export interface ReloadOrigin {
  toolCallId: string;
  parentToolCallId: string;
  sessionId: string;
  anchorId: string | null;
}

/** Full outcome for model delivery; the persisted visible entry contains only the summary. */
export interface ReloadOutcome extends ReloadOrigin {
  status: "reloaded" | "blocked";
  probe: StartupProbeResult;
}

const ENTRY_TYPE = "pi-reload-self-outcome";

/** Register a durable, searchable summary without adding model context. */
export function registerReloadOutcomeRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<{ status: ReloadOutcome["status"]; parentToolCallId: string; summary: string }>(
    ENTRY_TYPE,
    (entry, _options, theme) => new Text(
      theme.fg(entry.data!.status === "reloaded" ? "success" : "error", entry.data!.summary), 0, 0,
    ),
  );
}

/** Keep concise linked presentation independent from complete, hidden model delivery. */
export function publishReloadOutcome(pi: ExtensionAPI, outcome: ReloadOutcome): void {
  const summary = outcome.status === "reloaded"
    ? "Pi reloaded. Continuing with the requested prompt."
    : "Reload blocked: the final startup check failed. Pi was not reloaded; fix the startup error before retrying.";
  pi.appendEntry(ENTRY_TYPE, { status: outcome.status, parentToolCallId: outcome.parentToolCallId, summary });
  pi.sendMessage({
    customType: "pi-reload-self", display: false,
    content: `${summary}\nCWD: ${outcome.probe.cwd}\n${outcome.probe.diagnostics.join("\n")}`.trimEnd(),
    details: outcome,
  }, outcome.status === "blocked" ? { triggerTurn: true, deliverAs: "followUp" } : undefined);
}
