const CONTINUATION_SLOT = "__piReloadSelfContinuationPrompt";
const PENDING_COMMAND_SLOT = "__piReloadSelfPendingCommand";

interface ReloadSelfGlobalState {
  [CONTINUATION_SLOT]?: string;
  [PENDING_COMMAND_SLOT]?: string;
}

function globalState(): ReloadSelfGlobalState {
  return globalThis as ReloadSelfGlobalState;
}

export function storeContinuationPrompt(prompt: string): void {
  globalState()[CONTINUATION_SLOT] = prompt;
}

export function takeContinuationPrompt(): string | undefined {
  const state = globalState();
  const prompt = state[CONTINUATION_SLOT];
  delete state[CONTINUATION_SLOT];
  return prompt;
}

/** Store one encoded command until the current agent run has settled. */
export function storePendingReloadCommand(command: string): boolean {
  const state = globalState();
  if (state[PENDING_COMMAND_SLOT]) return false;
  state[PENDING_COMMAND_SLOT] = command;
  return true;
}

export function takePendingReloadCommand(): string | undefined {
  const state = globalState();
  const command = state[PENDING_COMMAND_SLOT];
  delete state[PENDING_COMMAND_SLOT];
  return command;
}

/** Drop a command that cannot belong to a newly started/reloaded session. */
export function clearPendingReloadCommand(): void {
  delete globalState()[PENDING_COMMAND_SLOT];
}
