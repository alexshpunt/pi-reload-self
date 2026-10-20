# pi-reload-self

Pi extension development helper that lets agents reload Pi and continue in the same session.

It registers one LLM-callable tool:

```ts
pi_extension_dev_reload_self({
  continuation_prompt: "Continue after reload...",
  confirm_state_loss: true,
})
```

## Warning

Reloading Pi can reset extension/module in-memory state, hot-loaded resources, timers, watchers, and other extension-maintained runtime state. Use this only when you explicitly want Pi to reload extensions, skills, prompts, and themes.

The tool requires `confirm_state_loss: true` so agents cannot queue a reload accidentally.

## Install

From GitHub:

```bash
pi install git:github.com/clankercode/pi-reload-self
```

For local development from this repository:

```bash
pi -ne -e ./src/index.ts
```

Or install the local package path:

```bash
pi install /path/to/pi-reload-self
```

## Tool behavior

`pi_extension_dev_reload_self` accepts:

- `continuation_prompt` — non-empty prompt sent after reload.
- `confirm_state_loss` — must be `true`.

Flow:

1. The tool validates the prompt and confirmation, then starts a separate Pi RPC process in the current session’s working directory. It inherits the running CLI installation, environment, global and project settings, trust decision, and explicit resource-loading options. It does not resume the conversation or send a model prompt.
2. The probe waits for startup handlers and an RPC readiness response. Startup errors or a 60-second timeout block reload; warnings are reported without blocking it. The probe is closed after every outcome, including cancellation.
3. If startup succeeds, the tool queues one internal `/pi-reload-self-run ...` command. On Pi’s public `agent_settled` event, the extension dispatches it with `expandPromptTemplates: true`.
4. The command checks startup again immediately before `ctx.reload()`, so a change made while the agent was settling cannot bypass the check. Direct calls to the internal command use the same check.
5. After a successful reload, the reloaded extension sends the continuation prompt as a follow-up user message.

The tool's first result is a scheduling receipt, not proof that Pi reloaded. After the final startup check, a tool-initiated reload gets one saved outcome linked to its original visible call. Nested calls use the outer tool's real execution identity. Stereo View shows the outcome beside that call without a second card in Conversation; the original receipt and chronological session history stay unchanged.

A blocked final check leaves Pi running and sends the full diagnostics to the agent. A successful outcome is recorded only when the fresh runtime starts, then the requested continuation is sent once. The visible summary stays separate from the full agent-facing data. Direct `/pi-reload-self-run` commands do not acquire tool-call ownership.

The probe runs extension startup handlers, so those handlers can repeat their external side effects. RPC startup does not verify TUI-only code. SDK hosts whose launch configuration cannot be reproduced are refused rather than checked with a different configuration.

The extension reloads in place; it does not create a new session. The pending command is consumed once at `agent_settled`, and is cleared if a session is replaced/reloaded before it settles. The command handoff uses Pi's public command-dispatch API; no Pi internal modules are patched and no manual editor submission is required.

## Compatibility

Requires Pi `>=1.3.0`, including support for returning a failed tool result with structured diagnostics.

## Development

```bash
npm install
just check
```

Individual commands:

```bash
just test
just typecheck
```

## Package manifest

This package declares its Pi extension entrypoint in `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

## License

MIT
