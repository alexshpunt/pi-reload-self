import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { StartupProbeOptions } from "./startup-probe.ts";

type ProbeContext = Pick<ExtensionContext, "isProjectTrusted" | "model" | "thinkingLevel">;

function resourcePath(value: string, cwd: string): string {
  if (value.startsWith("builtin:")) return value;
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return resolve(cwd, value);
}

/** Keep startup configuration, not the parent's conversation, prompt or output mode. */
export function buildProbeArgs(argv: string[], launchCwd: string, context: ProbeContext): string[] {
  const parsed = parseArgs(argv);
  const args = ["--mode", "rpc", "--no-session", context.isProjectTrusted() ? "--approve" : "--no-approve"];
  const flag = (name: string, value: unknown) => { if (value) args.push(name); };
  const value = (name: string, input: string | undefined) => {
    if (input !== undefined) args.push(name, input);
  };
  for (const [name, paths] of [
    ["--extension", parsed.extensions], ["--skill", parsed.skills],
    ["--prompt-template", parsed.promptTemplates], ["--theme", parsed.themes],
  ] as const) {
    for (const path of paths ?? []) args.push(name, resourcePath(path, launchCwd));
  }
  flag("--no-extensions", parsed.noExtensions);
  flag("--no-mcp", "noMcp" in parsed && parsed.noMcp);
  flag("--no-skills", parsed.noSkills);
  flag("--no-prompt-templates", parsed.noPromptTemplates);
  flag("--no-themes", parsed.noThemes);
  flag("--no-context-files", parsed.noContextFiles);
  flag("--no-tools", parsed.noTools);
  flag("--no-builtin-tools", parsed.noBuiltinTools);
  flag("--offline", parsed.offline);
  value("--tools", parsed.tools?.join(","));
  value("--exclude-tools", parsed.excludeTools?.join(","));
  value("--use-theme", parsed.useTheme);
  value("--provider", context.model?.provider ?? parsed.provider);
  value("--model", context.model?.id ?? parsed.model);
  value("--thinking", context.thinkingLevel ?? parsed.thinking);
  value("--api-key", parsed.apiKey);
  value("--models", parsed.models?.join(","));

  const prompt = (text: string) => existsSync(resolve(launchCwd, text)) ? resolve(launchCwd, text) : text;
  if (parsed.systemPrompt !== undefined) value("--system-prompt", prompt(parsed.systemPrompt));
  for (const text of parsed.appendSystemPrompt ?? []) value("--append-system-prompt", prompt(text));
  const sessionFlags = new Set([
    "mode", "print", "continue", "resume", "session", "session-id", "fork",
    "session-dir", "name", "export", "help", "version", "list-models",
  ]);
  for (const [name, input] of parsed.unknownFlags) {
    if (!sessionFlags.has(name)) args.push(input === true ? `--${name}` : `--${name}=${input}`);
  }
  return args;
}

function currentCli(): string {
  const entry = process.argv[1] && realpathSync(process.argv[1]);
  if (!entry) throw new Error("Cannot identify the current Pi CLI.");
  // Resolve the running installation rather than a different Pi found on PATH
  // or a development dependency belonging to this extension.
  for (let dir = dirname(entry); ; dir = dirname(dir)) {
    const manifestPath = join(dir, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.name === "@earendil-works/pi-coding-agent") return entry;
    }
    if (dirname(dir) === dir) break;
  }
  throw new Error("Cannot reproduce this host's Pi launch. Self-reload requires a Pi CLI process.");
}

/** Capture the running CLI configuration while taking CWD and trust from the fresh session context. */
export function createProbeLaunch(context: ExtensionContext, launchCwd: string): StartupProbeOptions {
  return {
    cliPath: currentCli(),
    cwd: context.cwd,
    args: buildProbeArgs(process.argv.slice(2), launchCwd, context),
    env: { ...process.env },
  };
}
