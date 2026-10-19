import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function armStartupFailure(pi: ExtensionAPI): void {
  const directory = process.env.RELOAD_FIXTURE_DIR!;
  if (existsSync(join(directory, "armed"))) throw new Error("fixture-armed-startup-failure");

  pi.on("session_start", () => {
    appendFileSync(join(directory, "starts"), `${process.pid}\n`);
  });
  pi.registerTool({
    name: "arm_startup_failure",
    label: "Arm startup failure",
    description: "Make the next startup fail without breaking the running fixture.",
    parameters: Type.Object({}),
    async execute() {
      writeFileSync(join(directory, "armed"), "armed");
      return { content: [{ type: "text", text: "Next startup will fail." }], details: {} };
    },
  });
}
