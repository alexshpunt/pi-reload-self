import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildProbeArgs } from "../src/probe-launch.ts";

type ProbeContext = Parameters<typeof buildProbeArgs>[2];

const launchCwd = path.resolve("fixtures", "initial-launch-directory");

function context(overrides: Partial<ProbeContext> = {}): ProbeContext {
  return {
    isProjectTrusted: () => true,
    model: undefined,
    thinkingLevel: "high",
    ...overrides,
  };
}

function optionValues(args: string[], ...names: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (names.includes(arg)) {
      values.push(args[index + 1]);
      index += 1;
      continue;
    }
    for (const name of names) {
      if (arg.startsWith(`${name}=`)) values.push(arg.slice(name.length + 1));
    }
  }
  return values;
}

test("probe arguments cannot resume a conversation, export it, or send the initial prompt", () => {
  const args = buildProbeArgs([
    "--continue", "-c", "--resume", "-r",
    "--session", "original-session.jsonl",
    "--session-id", "original-id",
    "--fork", "fork-source.jsonl",
    "--session-dir", "original-session-directory",
    "--name", "original-session-name",
    "-n", "another-session-name",
    "--mode", "json", "--print", "-p",
    "--export", "export-source.jsonl", "export-destination.html",
    "--help", "-h", "--version", "-v", "--list-models", "search-models",
    "initial prompt", "@attached-file.txt",
    "--", "--flag-looking-prompt", "@after-separator.txt",
  ], launchCwd, context());

  assert.deepEqual(optionValues(args, "--mode"), ["rpc"]);
  assert.ok(args.includes("--no-session"));
  for (const discarded of [
    "--continue", "-c", "--resume", "-r", "--session", "--session-id", "original-id",
    "--fork", "--session-dir", "--name", "-n", "--print", "-p", "--export",
    "--help", "-h", "--version", "-v", "--list-models",
    "original-session.jsonl", "fork-source.jsonl", "original-session-directory",
    "original-session-name", "another-session-name", "json", "export-source.jsonl",
    "export-destination.html", "search-models", "initial prompt", "@attached-file.txt",
    "--", "--flag-looking-prompt", "@after-separator.txt",
  ]) {
    assert.ok(!args.includes(discarded), `Probe must not inherit ${discarded}`);
  }
});

test("reserved session flags cannot be forwarded through unknown extension flags", () => {
  // Pi parses this spelling as an unknown flag, not as its built-in session option.
  const args = buildProbeArgs(["--session-id=original-id"], launchCwd, context());

  assert.deepEqual(optionValues(args, "--session-id"), []);
  assert.ok(!args.includes("--session-id=original-id"));
  assert.ok(!args.includes("original-id"));
  assert.ok(args.includes("--no-session"));
});

test("current project trust overrides both trusted and untrusted launch flags", () => {
  const trusted = buildProbeArgs(["--no-approve", "-na"], launchCwd, context());
  assert.ok(trusted.includes("--approve"));
  assert.ok(!trusted.includes("--no-approve"));
  assert.ok(!trusted.includes("-na"));

  const untrusted = buildProbeArgs(["--approve", "-a"], launchCwd, context({
    isProjectTrusted: () => false,
  }));
  assert.ok(untrusted.includes("--no-approve"));
  assert.ok(!untrusted.includes("--approve"));
  assert.ok(!untrusted.includes("-a"));
});

test("the current model and thinking level replace the original CLI selection", () => {
  const model: NonNullable<ProbeContext["model"]> = {
    id: "current-model",
    name: "Current model",
    provider: "current-provider",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
  const args = buildProbeArgs([
    "--provider", "original-provider", "--model", "original-model", "--thinking", "low",
  ], launchCwd, context({ model, thinkingLevel: "medium" }));

  assert.deepEqual(optionValues(args, "--provider"), ["current-provider"]);
  assert.deepEqual(optionValues(args, "--model"), ["current-model"]);
  assert.deepEqual(optionValues(args, "--thinking"), ["medium"]);
  assert.ok(!args.includes("original-provider"));
  assert.ok(!args.includes("low"));
});

test("CLI model selection survives when the current context has no model", () => {
  const args = buildProbeArgs([
    "--provider", "fallback-provider", "--model", "fallback-model", "--thinking", "minimal",
  ], launchCwd, context());

  assert.deepEqual(optionValues(args, "--provider"), ["fallback-provider"]);
  assert.deepEqual(optionValues(args, "--model"), ["fallback-model"]);
  assert.deepEqual(optionValues(args, "--thinking"), ["high"]);

  const defaults = buildProbeArgs([], launchCwd, context());
  assert.deepEqual(optionValues(defaults, "--model", "--provider"), []);
});

test("explicit resource paths stay rooted at the initial launch directory", () => {
  const absoluteTheme = path.resolve("fixtures", "absolute-theme.json");
  const args = buildProbeArgs([
    "-e", "./extensions/first.ts",
    "--extension", "../shared/second.ts",
    "--skill", "./skills/review",
    "--prompt-template", "./prompts/review.md",
    "--theme", absoluteTheme,
    "--use-theme", "solarized/dark",
  ], launchCwd, context());

  assert.deepEqual(optionValues(args, "--extension", "-e"), [
    path.resolve(launchCwd, "extensions/first.ts"),
    path.resolve(launchCwd, "../shared/second.ts"),
  ]);
  assert.deepEqual(optionValues(args, "--skill"), [path.resolve(launchCwd, "skills/review")]);
  assert.deepEqual(optionValues(args, "--prompt-template"), [
    path.resolve(launchCwd, "prompts/review.md"),
  ]);
  assert.deepEqual(optionValues(args, "--theme"), [absoluteTheme]);
  assert.deepEqual(optionValues(args, "--use-theme"), ["solarized/dark"]);
});

test("builtin extensions stay identifiers and home-relative resources expand", () => {
  const args = buildProbeArgs([
    "--extension", "builtin:mcp",
    "--extension", "~/pi-resources/extension.ts",
    "--skill", "~/pi-resources/skills",
    "--theme", "~/pi-resources/theme.json",
  ], launchCwd, context());

  assert.deepEqual(optionValues(args, "--extension", "-e"), [
    "builtin:mcp",
    path.join(homedir(), "pi-resources/extension.ts"),
  ]);
  assert.deepEqual(optionValues(args, "--skill"), [path.join(homedir(), "pi-resources/skills")]);
  assert.deepEqual(optionValues(args, "--theme"), [path.join(homedir(), "pi-resources/theme.json")]);
});

test("resource discovery controls, tool selection and offline settings are inherited", () => {
  const flags = [
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
    "--no-context-files", "--no-mcp", "--no-builtin-tools", "--offline",
  ];
  const args = buildProbeArgs([
    ...flags,
    "--tools", "+codemode,-write",
    "--exclude-tools", "mcp__private__*",
    "--api-key", "ephemeral-test-key",
  ], launchCwd, context());

  for (const flag of flags) assert.ok(args.includes(flag), `Probe must inherit ${flag}`);
  assert.deepEqual(optionValues(args, "--tools", "-t"), ["+codemode,-write"]);
  assert.deepEqual(optionValues(args, "--exclude-tools", "-xt"), ["mcp__private__*"]);
  assert.deepEqual(optionValues(args, "--api-key"), ["ephemeral-test-key"]);
});

test("short resource and tool flags retain their disabling and selection effects", () => {
  const args = buildProbeArgs([
    "-ne", "-ns", "-np", "-nc", "-nt", "-nbt",
    "-t", "read,codemode", "-xt", "write",
  ], launchCwd, context());

  for (const names of [
    ["-ne", "--no-extensions"],
    ["-ns", "--no-skills"],
    ["-np", "--no-prompt-templates"],
    ["-nc", "--no-context-files"],
    ["-nt", "--no-tools"],
    ["-nbt", "--no-builtin-tools"],
  ]) {
    assert.ok(names.some((name) => args.includes(name)), `Probe must preserve ${names[0]}`);
  }
  assert.deepEqual(optionValues(args, "--tools", "-t"), ["read,codemode"]);
  assert.deepEqual(optionValues(args, "--exclude-tools", "-xt"), ["write"]);
});

test("prompt text remains literal and existing prompt files use the launch directory", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-reload-self-probe-args-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(directory, "system.md"), "System file\n");
  writeFileSync(path.join(directory, "append.md"), "Append file\n");

  const args = buildProbeArgs([
    "--system-prompt", "./system.md",
    "--append-system-prompt", "./append.md",
    "--append-system-prompt", "Keep this as literal prompt text.",
  ], directory, context());

  assert.deepEqual(optionValues(args, "--system-prompt"), [path.join(directory, "system.md")]);
  assert.deepEqual(optionValues(args, "--append-system-prompt"), [
    path.join(directory, "append.md"),
    "Keep this as literal prompt text.",
  ]);
  const literal = buildProbeArgs([
    "--system-prompt", "This is literal system prompt text.",
  ], directory, context());
  assert.deepEqual(optionValues(literal, "--system-prompt"), ["This is literal system prompt text."]);
});

test("unknown extension flags keep their values without retaining unrelated prompts", () => {
  const args = buildProbeArgs([
    "--custom-mode", "safe mode",
    "--extension-config=@opaque-extension-value",
    "--custom-path=./opaque-config.json",
    "unrelated initial prompt",
    "--custom-switch",
  ], launchCwd, context());

  assert.deepEqual(optionValues(args, "--custom-mode"), ["safe mode"]);
  assert.deepEqual(optionValues(args, "--extension-config"), ["@opaque-extension-value"]);
  assert.deepEqual(optionValues(args, "--custom-path"), ["./opaque-config.json"]);
  assert.ok(args.includes("--custom-switch"));
  assert.ok(!args.includes("unrelated initial prompt"));
});
