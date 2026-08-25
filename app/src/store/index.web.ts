// Web storage factory. Kept separate from the native index so the web bundle never
// pulls in expo-sqlite (whose wasm worker cannot be bundled for static web).
import type { Storage } from "./types";
import { MemoryStorage } from "./memory";

export function createStorage(): Storage {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { WebStorage } = require("./web");
    return new WebStorage();
  } catch {
    return new MemoryStorage();
  }
}

export { MemoryStorage } from "./memory";
export type { Storage } from "./types";
