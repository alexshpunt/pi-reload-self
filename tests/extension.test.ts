import assert from "node:assert/strict";
import test from "node:test";

import extension from "../src/index.ts";
import { encodeReloadPayload } from "../src/payload.ts";
import { clearPendingReloadCommand } from "../src/runtime-reload.ts";

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
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
}

interface FakeCommandContext {
  reload: () => Promise<void>;
  isIdle: () => boolean;
  ui?: { notify: (message: string, level: string) => void };
}

async function loadExtension() {
  clearPendingReloadCommand();

  const commands = new Map<string, RegisteredCommand>();
  const tools = new Map<string, RegisteredTool>();
  const sentUserMessages: Array<{
    content: string;
    options?: { deliverAs?: string; expandPromptTemplates?: boolean };
  }> = [];
  const handlers = new Map<string, Array<(...args: never[]) => unknown>>();

  const fakePi = {
    registerCommand(name: string, command: RegisteredCommand) {
      commands.set(name, command);
    },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
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

  await extension(fakePi as never);

  return { commands, tools, sentUserMessages, handlers };
}

test("registers pi_extension_dev_reload_self tool and internal command", async () => {
  const { commands, tools } = await loadExtension();

  assert.ok(commands.has("pi-reload-self-run"));
  assert.ok(tools.has("pi_extension_dev_reload_self"));
  assert.match(
    tools.get("pi_extension_dev_reload_self")?.description ?? "",
    /reset extension\/module in-memory state/,
  );
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
