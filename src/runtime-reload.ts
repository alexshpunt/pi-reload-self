import type { ReloadOutcome } from "./reload-outcome.ts";

/** Plain data transferred to the fresh runtime after a successful reload. */
export interface ReloadContinuation {
  prompt: string;
  outcome?: ReloadOutcome;
}
const CONTINUATION_SLOT = "__piReloadSelfContinuationPrompt";
const OUTCOME_SLOT = "__piReloadSelfOutcome";
const PENDING_COMMAND_SLOT = "__piReloadSelfPendingCommand";
const LAUNCH_CWD_SLOT = "__piReloadSelfLaunchCwd";

interface ReloadSelfGlobalState {
  [CONTINUATION_SLOT]?: string;
  [OUTCOME_SLOT]?: ReloadOutcome;
  [PENDING_COMMAND_SLOT]?: string;
  [LAUNCH_CWD_SLOT]?: string;
}

function globalState(): ReloadSelfGlobalState {
  return globalThis as ReloadSelfGlobalState;
}

/** Keep the CLI launch origin stable across resource reloads and process.chdir(). */
export function getInitialLaunchCwd(): string {
  const state = globalState();
  return state[LAUNCH_CWD_SLOT] ??= process.cwd();
}
export function storeContinuationPrompt(prompt: string, outcome?: ReloadOutcome): void {
  const state = globalState();
  state[CONTINUATION_SLOT] = prompt;
  state[OUTCOME_SLOT] = outcome;
}

export function takeContinuationPrompt(): ReloadContinuation | undefined {
  const state = globalState();
  const prompt = state[CONTINUATION_SLOT];
  const outcome = state[OUTCOME_SLOT];
  delete state[CONTINUATION_SLOT];
  delete state[OUTCOME_SLOT];
  return prompt === undefined ? undefined : { prompt, outcome };
}

/** Whether a checked reload is already waiting for the originating run to settle. */
export function hasPendingReloadCommand(): boolean {
  return Boolean(globalState()[PENDING_COMMAND_SLOT]);
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
