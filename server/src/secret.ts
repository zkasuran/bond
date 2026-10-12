// The server-only MAC key behind every stateless token and challenge (device sessions and the
// skill-claim challenge). SESSION_SECRET from the environment, or 32 random bytes per process.
// The random fallback is safe: a restart signs every device out and the app re-authenticates
// on its next 401. It only stops sessions surviving a restart or spanning several instances.
// Rotating SESSION_SECRET revokes every outstanding session and challenge at once.
import { randomBytes } from "node:crypto";
import { config } from "./config.js";

let secret: string = config.sessionSecret || randomBytes(32).toString("hex");

export function serverSecret(): string {
  return secret;
}

/** Test hook: pin the key so a test can mint and check tokens deterministically. */
export function setServerSecretForTest(s: string): void {
  secret = s;
}
