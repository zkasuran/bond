// Storage factory. Picks the platform adapter at runtime and falls back to in-memory so
// the app always has a working store, including on web or under tests. The platform
// modules are required lazily so a missing native module degrades instead of crashing.
import { Platform } from "react-native";
import type { Storage } from "./types";
import { MemoryStorage } from "./memory";

export function createStorage(): Storage {
  try {
    if (Platform.OS === "web") {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { WebStorage } = require("./web");
      return new WebStorage();
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SqliteStorage } = require("./sqlite");
    return new SqliteStorage();
  } catch {
    return new MemoryStorage();
  }
}

export { MemoryStorage } from "./memory";
export type { Storage } from "./types";
