export interface ReloadPayload {
  continuationPrompt: string;
  /** Opaque reference to a request owned by the current extension runtime, never an owner supplied by a command. */
  requestId?: string;
}

const INVALID_PAYLOAD_MESSAGE = "Invalid reload payload";
const INVALID_PROMPT_MESSAGE = "next_action must be a non-empty string";
const BASE64URL_TOKEN_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/;

export function validateContinuationPrompt(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(INVALID_PROMPT_MESSAGE);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(INVALID_PROMPT_MESSAGE);
  }

  return trimmed;
}

export function encodeReloadPayload(payload: ReloadPayload): string {
  const normalized: ReloadPayload = {
    continuationPrompt: validateContinuationPrompt(payload.continuationPrompt),
    ...(payload.requestId === undefined ? {} : { requestId: payload.requestId }),
  };

  return Buffer.from(JSON.stringify(normalized), "utf8").toString("base64url");
}

export function extractReloadPayloadToken(args: string, commandName = "pi-reload-self-run"): string {
  const trimmed = args.trim();
  const withoutCommand = trimmed.startsWith(`/${commandName}`)
    ? trimmed.slice(commandName.length + 1).trim()
    : trimmed.startsWith(commandName)
      ? trimmed.slice(commandName.length).trim()
      : trimmed;
  const [token] = withoutCommand.split(/\s+/, 1);

  if (!token || !BASE64URL_TOKEN_PATTERN.test(token)) {
    throw new Error(INVALID_PAYLOAD_MESSAGE);
  }

  return token.replace(/=+$/, "");
}

export function decodeReloadPayload(encoded: string): ReloadPayload {
  try {
    const token = extractReloadPayloadToken(encoded);
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Payload is not an object");
    }

    const continuationPrompt = validateContinuationPrompt(
      (parsed as { continuationPrompt?: unknown }).continuationPrompt,
    );

    const requestId = (parsed as { requestId?: unknown }).requestId;
    if (requestId !== undefined && (typeof requestId !== "string" || requestId.length === 0)) {
      throw new Error("Invalid request identity");
    }
    return { continuationPrompt, ...(requestId === undefined ? {} : { requestId }) };
  } catch (error) {
    throw new Error(INVALID_PAYLOAD_MESSAGE, { cause: error });
  }
}
