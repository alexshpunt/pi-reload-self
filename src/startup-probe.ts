import { spawn, type ChildProcess } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

/** One isolated Pi CLI launch; args must select RPC and an in-memory session. */
export interface StartupProbeOptions {
  cwd: string;
  cliPath: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Startup readiness is distinct from a live process or a successful help exit. */
export interface StartupProbeResult {
  ok: boolean;
  cwd: string;
  reason: string;
  diagnostics: string[];
}

const OUTPUT_LIMIT = 64 * 1024;
const REQUEST_ID = "pi-reload-self-startup";

function signalProcess(child: ChildProcess, signal: NodeJS.Signals): string | undefined {
  if (!child.pid) return;
  try {
    // A stalled extension can own subprocesses that also need to be stopped.
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    try { child.kill(signal); } catch { /* The cleanup deadline handles an unkillable process. */ }
    return `Cannot signal startup process ${child.pid}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Start Pi without a prompt, require an RPC readiness response, then dispose it. */
export async function probeStartup(options: StartupProbeOptions): Promise<StartupProbeResult> {
  const diagnostics: string[] = [];
  if (options.signal?.aborted) {
    return { ok: false, cwd: options.cwd, reason: "cancelled", diagnostics: ["Startup check cancelled."] };
  }

  const child = spawn(process.execPath, [options.cliPath, ...options.args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let failed = false;
  let reason = "ready";
  let stopSignal: NodeJS.Signals | undefined;
  let stdout = "";
  let stderr = "";
  let outputSize = 0;
  let resolveReady: () => void;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  const fail = (why: string, message: string) => {
    if (!failed) reason = why;
    failed = true;
    diagnostics.push(message);
    resolveReady();
  };
  const closedPromise = new Promise<void>((resolve) => {
    child.once("close", (code, signal) => {
      if ((code !== 0 || signal) && !(responded && signal === stopSignal)) {
        fail("exit", `Startup process exited (${signal ?? code}).`);
      } else if (!responded) fail("exit", "Startup process exited before RPC readiness.");
      resolveReady();
      resolve();
    });
  });
  let responded = false;
  const timer = setTimeout(() => fail("timeout", "Startup check timed out."), options.timeoutMs ?? 60_000);
  const onAbort = () => fail("cancelled", "Startup check cancelled.");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  child.on("error", (error) => fail("process-error", `Cannot start Pi: ${error.message}`));
  child.stdin.on("error", (error) => fail("process-error", `RPC input failed: ${error.message}`));
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const record = (line: string) => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      fail("protocol-error", `Invalid RPC output: ${stripVTControlCharacters(line).slice(0, 1000)}`);
      return;
    }
    if (!event || typeof event !== "object") {
      fail("protocol-error", "Invalid RPC record.");
    } else if (event.type === "extension_error") {
      fail("startup-error", `${event.extensionPath} (${event.event}): ${event.error}`);
    } else if (event.type === "extension_ui_request" && event.method === "notify") {
      if (event.notifyType === "error") fail("startup-error", String(event.message));
      else if (event.notifyType === "warning") diagnostics.push(String(event.message));
    } else if (event.type === "response" && event.id === REQUEST_ID) {
      if (event.command !== "get_state" || event.success !== true) {
        fail("startup-error", String(event.error ?? "RPC startup check failed."));
      } else {
        responded = true;
        resolveReady();
      }
    }
  };
  child.stdout.on("data", (chunk: string) => {
    outputSize += chunk.length;
    if (outputSize > OUTPUT_LIMIT) {
      fail("protocol-error", "Startup output exceeded the 64 KiB limit.");
      return;
    }
    stdout += chunk;
    let end;
    while ((end = stdout.indexOf("\n")) !== -1) {
      const line = stdout.slice(0, end).replace(/\r$/, "");
      stdout = stdout.slice(end + 1);
      record(line);
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += stripVTControlCharacters(chunk);
    if (stderr.length > OUTPUT_LIMIT) {
      stderr = stderr.slice(0, OUTPUT_LIMIT);
      fail("startup-error", "Startup diagnostics exceeded the 64 KiB limit.");
    }
  });

  try {
    // Buffered stdin is read only after Pi has bound its startup handlers.
    child.stdin.write(`${JSON.stringify({ id: REQUEST_ID, type: "get_state" })}\n`);
    if (options.signal?.aborted) onAbort();
    await ready;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    child.stdin.end();
    // Let Pi run session_shutdown; force termination if startup/disposal is stuck.
    const stop = (signal: NodeJS.Signals) => {
      stopSignal = signal;
      const error = signalProcess(child, signal);
      if (error) fail("cleanup-error", error);
    };
    const terminate = setTimeout(() => stop("SIGTERM"), 500);
    const kill = setTimeout(() => stop("SIGKILL"), 1500);
    let cleanupTimer: ReturnType<typeof setTimeout>;
    const cleanupDeadline = new Promise<void>((resolve) => {
      cleanupTimer = setTimeout(() => {
        fail("cleanup-timeout", `Startup process ${child.pid} did not close its output pipes. Descendant processes may still be running.`);
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        resolve();
      }, 2000);
    });
    await Promise.race([closedPromise, cleanupDeadline]);
    clearTimeout(cleanupTimer!);
    clearTimeout(terminate);
    clearTimeout(kill);
  }

  if (stdout.trim()) fail("protocol-error", "Incomplete RPC output at shutdown.");
  if (stderr.trim()) {
    diagnostics.push(stderr.trim());
    if (/^Error: /m.test(stderr)) {
      failed = true;
      if (reason === "ready") reason = "startup-error";
    }
  }
  return { ok: responded && !failed, cwd: options.cwd, reason, diagnostics };
}
