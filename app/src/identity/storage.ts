// Load or create the device identity. The Ed25519 secret lives in expo-secure-store on
// native (iOS Keychain, Android Keystore). Web has no secure enclave, so it falls back
// to localStorage and the identity is labeled lower assurance rather than pretending
// otherwise. See DESIGN.md sec 5.
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { base64urlnopad } from "@scure/base";
import type { Identity } from "../model/node";
import { generateKeypair, keypairFromStoredSecret } from "./keys";

const SECRET_KEY = "bond.identity.secret";
const META_KEY = "bond.identity.meta";

export interface StoredIdentity {
  identity: Identity;
  secretKey: Uint8Array;
  assurance: "device" | "web";
}

async function readItem(key: string): Promise<string | null> {
  if (Platform.OS === "web") {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }
  return SecureStore.getItemAsync(key);
}

async function writeItem(key: string, value: string): Promise<void> {
  if (Platform.OS === "web") {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      // ignore, web identity is best-effort
    }
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

export async function loadOrCreateIdentity(displayName = "You"): Promise<StoredIdentity> {
  const assurance: StoredIdentity["assurance"] = Platform.OS === "web" ? "web" : "device";
  const existing = await readItem(SECRET_KEY);
  if (existing) {
    // A stored secret is untrusted input: a corrupted or hostile value must not crash the
    // load. keypairFromStoredSecret validates the encoding and the 32-byte length and
    // returns null on anything invalid, so a bad value falls through to a fresh identity
    // rather than throwing on launch.
    const kp = keypairFromStoredSecret(existing);
    if (kp) {
      const metaRaw = await readItem(META_KEY);
      const name = metaRaw ? (JSON.parse(metaRaw).displayName ?? displayName) : displayName;
      return {
        identity: { did: kp.did, displayName: name, kind: "human" },
        secretKey: kp.secretKey,
        assurance,
      };
    }
  }
  const kp = generateKeypair();
  await writeItem(SECRET_KEY, base64urlnopad.encode(kp.secretKey));
  await writeItem(META_KEY, JSON.stringify({ displayName }));
  return {
    identity: { did: kp.did, displayName, kind: "human" },
    secretKey: kp.secretKey,
    assurance,
  };
}

export async function setDisplayName(displayName: string): Promise<void> {
  await writeItem(META_KEY, JSON.stringify({ displayName }));
}
