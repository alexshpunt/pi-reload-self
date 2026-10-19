import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function startupFixture(pi: ExtensionAPI): void {
  if (process.env.PROBE_CASE === "load-error") throw new Error("fixture-load-failure");
  if (process.env.PROBE_CASE === "stderr-warning") console.error("Warning: fixture-stderr-warning");

  pi.registerProvider("startup-fixture", {
    baseUrl: "http://127.0.0.1:1",
    apiKey: "unused",
    api: "openai-completions",
    models: [{
      id: "startup-model", name: "Startup fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192, maxTokens: 1024,
    }],
    streamSimple: () => {
      writeFileSync(join(process.env.PROBE_RECORD_DIR!, "model-called"), "unexpected");
      throw new Error("The startup probe must not call a model");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    writeFileSync(join(process.env.PROBE_RECORD_DIR!, "started.json"), JSON.stringify({
      pid: process.pid, cwd: ctx.cwd, sentinel: process.env.PROBE_SENTINEL,
    }));
    if (process.env.PROBE_CASE === "handler-error") throw new Error("fixture-start-failure");
    if (process.env.PROBE_CASE === "notify-error") ctx.ui.notify("fixture-notify-error", "error");
    if (process.env.PROBE_CASE === "notify-warning") ctx.ui.notify("fixture-notify-warning", "warning");
    if (process.env.PROBE_CASE === "stall") await new Promise(() => { setInterval(() => {}, 1000); });
  });
  pi.on("session_shutdown", () => {
    if (process.env.PROBE_CASE === "slow-shutdown") return new Promise(() => { setInterval(() => {}, 1000); });
    writeFileSync(join(process.env.PROBE_RECORD_DIR!, "shutdown"), "done");
  });
}
