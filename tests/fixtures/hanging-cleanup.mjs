import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

process.stdin.once("data", () => {
  process.stdout.write(JSON.stringify({ type: "response", id: "pi-reload-self-startup", command: "get_state", success: true, data: {} }) + "\n");
});
process.stdin.once("end", () => {
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true, stdio: ["ignore", process.stdout, process.stderr],
  });
  writeFileSync(process.env.DESCENDANT_PID_FILE, String(descendant.pid));
  descendant.unref();
  process.exit(0);
});
