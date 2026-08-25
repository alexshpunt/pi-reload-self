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

1. The tool validates the prompt and confirmation, then stores one encoded internal `/pi-reload-self-run ...` command as pending state.
2. On Pi's public `agent_settled` event, after the originating run and any automatic continuation work are finished, the extension dispatches that command with `expandPromptTemplates: true`.
3. Pi invokes the command's `ExtensionCommandContext`; because the agent is idle, it calls `await ctx.reload()`.
4. The reloaded extension runtime sends the continuation prompt as a follow-up user message.

The extension reloads in place; it does not create a new session. The pending command is consumed once at `agent_settled`, and is cleared if a session is replaced/reloaded before it settles. The command handoff uses Pi's public command-dispatch API; no Pi internal modules are patched and no manual editor submission is required.

## Compatibility

Requires Pi `>=0.84.2`. Pi's changelog identifies `ctx.reload()` in 0.52.9, `agent_settled` in 0.80.4, and `expandPromptTemplates` command dispatch in 0.84.2; 0.84.3 is the live-tested release for this extension.

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
