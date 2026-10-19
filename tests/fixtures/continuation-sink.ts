import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function continuationSink(pi: ExtensionAPI): void {
  const records = join(process.env.PROBE_RECORD_DIR!, "reload-events.jsonl");
  pi.on("session_start", (event, ctx) => {
    appendFileSync(records, JSON.stringify({
      type: "start", pid: process.pid, sessionId: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd, reason: event.reason,
    }) + "\n");
  });
  pi.on("input", (event, ctx) => {
    if (event.text !== process.env.RELOAD_CONTINUATION) return { action: "continue" };
    appendFileSync(records, JSON.stringify({
      type: "continuation", pid: process.pid, sessionId: ctx.sessionManager.getSessionId(),
      text: event.text, source: event.source,
    }) + "\n");
    return { action: "handled" };
  });
}
