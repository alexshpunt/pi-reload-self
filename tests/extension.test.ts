import assert from "node:assert/strict";
import test from "node:test";

import { registerReloadSelf, type StartupCheck } from "../src/index.ts";
import { encodeReloadPayload } from "../src/payload.ts";
import { clearPendingReloadCommand, takeContinuationPrompt } from "../src/runtime-reload.ts";

interface RegisteredCommand {
  description: string;
  handler: (args: string, ctx: FakeCommandContext) => Promise<void> | void;
}

interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: { continuation_prompt: string; confirm_state_loss: boolean },
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
}

interface FakeCommandContext {
  reload: () => Promise<void>;
  isIdle: () => boolean;
  ui?: { notify: (message: string, level: string) => void };
}

async function loadExtension(check: StartupCheck = async (ctx) => ({
  ok: true, cwd: ctx?.cwd ?? "/session/current", reason: "ready", diagnostics: [],
})) {
  clearPendingReloadCommand();
  takeContinuationPrompt();

  const commands = new Map<string, RegisteredCommand>();
  const tools = new Map<string, RegisteredTool>();
  const sentUserMessages: Array<{
    content: string;
    options?: { deliverAs?: string; expandPromptTemplates?: boolean };
  }> = [];
  const handlers = new Map<string, Array<(...args: never[]) => unknown>>();
  const messages: unknown[] = [];

  const fakePi = {
    sendMessage(message: unknown) { messages.push(message); },
    registerCommand(name: string, command: RegisteredCommand) {
      commands.set(name, command);
    },
    registerTool(tool: RegisteredTool) {
      const execute = tool.execute;
      tools.set(tool.name, {
        ...tool,
        execute: (id, params, signal) => execute(id, params, signal, undefined, { cwd: "/session/current" }),
      });
    },
    sendUserMessage(content: string, options?: { deliverAs?: string; expandPromptTemplates?: boolean }) {
      sentUserMessages.push({ content, options });
    },
    on(name: string, handler: (...args: never[]) => unknown) {
      const existing = handlers.get(name) ?? [];
      existing.push(handler);
      handlers.set(name, existing);
    },
  };

  await registerReloadSelf(fakePi as never, check);

  return { commands, tools, sentUserMessages, handlers, messages };
}

test("registers pi_extension_dev_reload_self tool and internal command", async () => {
  const { commands, tools } = await loadExtension();

  assert.ok(commands.has("pi-reload-self-run"));
  assert.ok(tools.has("pi_extension_dev_reload_self"));
});

test("tool refuses to queue reload without explicit state loss confirmation", async () => {
  const { tools, sentUserMessages } = await loadExtension();
  const tool = tools.get("pi_extension_dev_reload_self");
  assert.ok(tool);

  const result = await tool.execute("tool-1", {
    continuation_prompt: "continue after reload",
    confirm_state_loss: false,
  });

  assert.deepEqual(sentUserMessages, []);
  assert.match(result.content[0]?.text ?? "", /confirm_state_loss: true/);
});

test("tool defers command dispatch until agent_settled and dispatches it once", async () => {
  const { commands, tools, sentUserMessages, handlers } = await loadExtension();
  const tool = tools.get("pi_extension_dev_reload_self");
  const command = commands.get("pi-reload-self-run");
  const settled = handlers.get("agent_settled")?.[0];
  assert.ok(tool);
  assert.ok(command);
  assert.ok(settled);

  const result = await tool.execute("tool-1", {
    continuation_prompt: "  continue after reload  ",
    confirm_state_loss: true,
  });
  const duplicate = await tool.execute("tool-2", {
    continuation_prompt: "a second continuation must not replace the first",
    confirm_state_loss: true,
  });
  assert.deepEqual(duplicate.details, { queued: false, reason: "already-queued" });

  // Tool execution only records pending state; it must not dispatch while the
  // originating agent run is active.
  assert.deepEqual(sentUserMessages, []);
  await settled({} as never, { isIdle: () => false } as never);
  assert.deepEqual(sentUserMessages, []);

  await settled({} as never, { isIdle: () => true } as never);
  const queued = sentUserMessages[0] as {
    content: string;
    options?: { deliverAs?: string; expandPromptTemplates?: boolean };
  };
  assert.equal(sentUserMessages.length, 1);
  assert.match(queued.content, /^\/pi-reload-self-run [A-Za-z0-9_-]+$/);
  assert.deepEqual(queued.options, { deliverAs: "followUp", expandPromptTemplates: true });

  // The settled handler is one-shot for this pending command.
  await settled({} as never, { isIdle: () => true } as never);
  assert.equal(sentUserMessages.length, 1);

  let reloaded = false;
  await command.handler(queued.content, {
    isIdle: () => true,
    reload: async () => {
      reloaded = true;
    },
  });
  assert.equal(reloaded, true);
  assert.match(result.content[0]?.text ?? "", /agent_settled/);
  assert.deepEqual(result.details, { queued: true, reason: "scheduled-after-settled" });
});

test("internal command reports invalid payload without reloading", async () => {
  const { commands, sentUserMessages } = await loadExtension();
  const command = commands.get("pi-reload-self-run");
  assert.ok(command);

  const events: string[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  await command.handler("not valid !!!", {
    isIdle: () => true,
    reload: async () => {
      events.push("reload");
    },
    ui: {
      notify: (message, level) => {
        notifications.push({ message, level });
      },
    },
  });

  assert.deepEqual(events, []);
  assert.deepEqual(sentUserMessages, []);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0]?.message ?? "", /Invalid reload payload/);
  assert.equal(notifications[0]?.level, "error");
});

test("internal command handles invalid payload when ui is unavailable", async () => {
  const { commands } = await loadExtension();
  const command = commands.get("pi-reload-self-run");
  assert.ok(command);

  await assert.doesNotReject(async () => {
    await command.handler("not valid !!!", {
      isIdle: () => true,
      reload: async () => {
        throw new Error("reload should not run");
      },
    });
  });
});

test("internal command reloads and session_start sends the continuation", async () => {
  const { commands, sentUserMessages, handlers } = await loadExtension();
  const command = commands.get("pi-reload-self-run");
  assert.ok(command);

  const events: string[] = [];
  const payload = encodeReloadPayload({ continuationPrompt: "continue after reload" });
  await command.handler(payload, {
    isIdle: () => true,
    reload: async () => {
      events.push("reload");
    },
  });

  assert.deepEqual(events, ["reload"]);
  assert.deepEqual(sentUserMessages, []);
  await handlers.get("session_start")?.[0]?.({} as never, {} as never);
  assert.deepEqual(sentUserMessages, [
    { content: "continue after reload", options: { deliverAs: "followUp" } },
  ]);
});

test("internal command accepts copied command text", async () => {
  const { commands } = await loadExtension();
  const command = commands.get("pi-reload-self-run");
  assert.ok(command);

  const payload = encodeReloadPayload({ continuationPrompt: "continue after reload" });
  let reloaded = false;
  await command.handler(`/pi-reload-self-run ${payload}`, {
    isIdle: () => true,
    reload: async () => {
      reloaded = true;
    },
  });

  assert.equal(reloaded, true);
});

for (const failByThrowing of [false, true]) {
  test(`failed startup ${failByThrowing ? "exception" : "result"} cannot queue a reload`, async () => {
    const { tools, handlers, sentUserMessages } = await loadExtension(async (ctx) => {
      if (failByThrowing) throw new Error("fixture-probe-error");
      return { ok: false, cwd: ctx.cwd, reason: "startup-error", diagnostics: ["fixture-probe-error"] };
    });
    const result = await tools.get("pi_extension_dev_reload_self")!.execute("failed", {
      continuation_prompt: "must never run", confirm_state_loss: true,
    });
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(result.content[0].text, /fixture-probe-error/);
    assert.match(result.content[0].text, /CWD: \/session\/current/);
    await handlers.get("agent_settled")![0]({} as never, { isIdle: () => true } as never);
    assert.deepEqual(sentUserMessages, []);
  });
}

test("the direct reload command also checks startup and records its failure", async () => {
  const { commands, handlers, sentUserMessages, messages } = await loadExtension(async () => ({
    ok: false, cwd: "/current/session", reason: "timeout", diagnostics: ["fixture-timeout"],
  }));
  let reloads = 0;
  await commands.get("pi-reload-self-run")!.handler(
    encodeReloadPayload({ continuationPrompt: "must never run" }),
    { isIdle: () => true, reload: async () => { reloads += 1; } },
  );
  await handlers.get("session_start")![0]({} as never, {} as never);
  assert.equal(reloads, 0);
  assert.deepEqual(sentUserMessages, []);
  assert.equal(messages.length, 1);
});

test("a second startup failure after settling blocks the previously checked reload", async () => {
  let checks = 0;
  const { commands, tools, handlers, sentUserMessages } = await loadExtension(async (ctx) => ({
    ok: ++checks === 1, cwd: ctx?.cwd ?? "/session/current", reason: checks === 1 ? "ready" : "startup-error",
    diagnostics: checks === 1 ? [] : ["changed-on-disk"],
  }));
  await tools.get("pi_extension_dev_reload_self")!.execute("checked", {
    continuation_prompt: "must never run", confirm_state_loss: true,
  });
  await handlers.get("agent_settled")![0]({} as never, { isIdle: () => true } as never);
  let reloaded = false;
  await commands.get("pi-reload-self-run")!.handler(sentUserMessages[0].content, {
    isIdle: () => true, reload: async () => { reloaded = true; },
  });
  await handlers.get("session_start")![0]({} as never, {} as never);
  assert.equal(checks, 2);
  assert.equal(reloaded, false);
  assert.equal(sentUserMessages.length, 1);
});

test("session replacement while checking cannot queue the old continuation", async () => {
  let finish!: () => void;
  const { tools, handlers, sentUserMessages } = await loadExtension(async (ctx) => {
    await new Promise<void>((resolve) => { finish = resolve; });
    return { ok: true, cwd: ctx.cwd, reason: "ready", diagnostics: [] };
  });
  const pending = tools.get("pi_extension_dev_reload_self")!.execute("pending", {
    continuation_prompt: "old session", confirm_state_loss: true,
  });
  await handlers.get("session_start")![0]({} as never, {} as never);
  finish();
  const result = await pending;
  assert.equal((result as { isError?: boolean }).isError, true);
  await handlers.get("agent_settled")![0]({} as never, { isIdle: () => true } as never);
  assert.deepEqual(sentUserMessages, []);
});

test("cancelling a check does not leave a queued command", async () => {
  const controller = new AbortController();
  const { tools, handlers, sentUserMessages } = await loadExtension(async (ctx) => {
    controller.abort();
    return { ok: true, cwd: ctx.cwd, reason: "ready", diagnostics: [] };
  });
  const result = await tools.get("pi_extension_dev_reload_self")!.execute("cancelled", {
    continuation_prompt: "cancelled", confirm_state_loss: true,
  }, controller.signal);
  assert.equal((result as { isError?: boolean }).isError, true);
  await handlers.get("agent_settled")![0]({} as never, { isIdle: () => true } as never);
  assert.deepEqual(sentUserMessages, []);
});

test("a rejected reload cannot leave its continuation armed", async () => {
  const { commands, handlers, sentUserMessages } = await loadExtension();
  await assert.rejects(async () => {
    await commands.get("pi-reload-self-run")!.handler(
      encodeReloadPayload({ continuationPrompt: "stale continuation" }),
      { isIdle: () => true, reload: async () => { throw new Error("reload failed"); } },
    );
  }, /reload failed/);
  await handlers.get("session_start")![0]({} as never, {} as never);
  assert.deepEqual(sentUserMessages, []);
});

test("session invalidation during a command check never reads the old context again", async () => {
  let active = true;
  let finish!: () => void;
  const { commands, handlers } = await loadExtension(async () => {
    await new Promise<void>((resolve) => { finish = resolve; });
    throw new Error("probe cancelled by session change");
  });
  const ctx = {
    get cwd() { if (!active) throw new Error("context invalidated"); return "/old/session"; },
    get ui() { if (!active) throw new Error("context invalidated"); return undefined; },
    get signal() { if (!active) throw new Error("context invalidated"); return undefined; },
    isIdle: () => { if (!active) throw new Error("context invalidated"); return true; },
    reload: async () => { throw new Error("must not reload"); },
  };
  const pending = commands.get("pi-reload-self-run")!.handler(
    encodeReloadPayload({ continuationPrompt: "old session" }), ctx,
  );
  active = false;
  await handlers.get("session_shutdown")![0]({} as never, {} as never);
  await handlers.get("session_start")![0]({} as never, {} as never);
  finish();
  await assert.doesNotReject(async () => { await pending; });
});

test("a run starting during the final probe defers reload without losing its continuation", async () => {
  let idle = true;
  let checks = 0;
  let reloads = 0;
  const { commands, handlers, sentUserMessages } = await loadExtension(async () => {
    checks += 1;
    if (checks === 1) idle = false;
    return { ok: true, cwd: "/session/current", reason: "ready", diagnostics: [] };
  });
  const command = commands.get("pi-reload-self-run")!;
  const context = { isIdle: () => idle, reload: async () => { reloads += 1; } };
  const payload = encodeReloadPayload({ continuationPrompt: "continue exactly once" });
  await command.handler(payload, context);
  assert.equal(reloads, 0);
  idle = true;
  await handlers.get("agent_settled")![0]({} as never, { isIdle: () => true } as never);
  assert.equal(sentUserMessages.length, 1);
  await command.handler(sentUserMessages[0].content, context);
  assert.equal(reloads, 1);
  await handlers.get("session_start")![0]({} as never, {} as never);
  assert.deepEqual(sentUserMessages[1], {
    content: "continue exactly once", options: { deliverAs: "followUp" },
  });
  await handlers.get("agent_settled")![0]({} as never, { isIdle: () => true } as never);
  assert.equal(sentUserMessages.length, 2);
});