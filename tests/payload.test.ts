import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeReloadPayload,
  encodeReloadPayload,
  extractReloadPayloadToken,
  validateContinuationPrompt,
} from "../src/payload.ts";

test("validateContinuationPrompt returns trimmed non-empty prompt", () => {
  assert.equal(validateContinuationPrompt("  continue now  "), "continue now");
});

test("validateContinuationPrompt rejects empty prompts", () => {
  assert.throws(
    () => validateContinuationPrompt("   "),
    /next_action must be a non-empty string/,
  );
});

test("validateContinuationPrompt rejects non-string prompts", () => {
  assert.throws(
    () => validateContinuationPrompt(null),
    /next_action must be a non-empty string/,
  );
});

test("encodeReloadPayload and decodeReloadPayload round-trip multiline prompts", () => {
  const encoded = encodeReloadPayload({ continuationPrompt: "line one\nline two" });

  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeReloadPayload(encoded), { continuationPrompt: "line one\nline two" });
});

test("extractReloadPayloadToken accepts bare, padded, and copied command payloads", () => {
  const encoded = encodeReloadPayload({ continuationPrompt: "continue" });

  assert.equal(extractReloadPayloadToken(encoded), encoded);
  assert.equal(extractReloadPayloadToken(`${encoded}==`), encoded);
  assert.equal(extractReloadPayloadToken(`/pi-reload-self-run ${encoded}`), encoded);
  assert.equal(extractReloadPayloadToken(`pi-reload-self-run ${encoded} extra ignored`), encoded);
});

test("decodeReloadPayload accepts copied command text", () => {
  const encoded = encodeReloadPayload({ continuationPrompt: "continue" });

  assert.deepEqual(decodeReloadPayload(`/pi-reload-self-run ${encoded}`), {
    continuationPrompt: "continue",
  });
});

test("decodeReloadPayload rejects invalid base64 or shape", () => {
  assert.throws(() => decodeReloadPayload("not valid !!!"), /Invalid reload payload/);
});
