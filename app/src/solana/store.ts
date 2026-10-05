// Self-contained wallet store. Separate from the main Bond engine store (state/store.ts) on
// purpose: wallet state is Android-only and optional, so it lives on its own and the rest of
// the app does not depend on it. Holds the connected address, the MWA auth token and the
// identity binding. Actions wrap solana/wallet.ts and solana/binding.ts and never throw:
// failures land in `error` so the UI can show them.
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import {
  connectWallet,
  disconnectWallet,
  isWalletAvailable,
  reauthorize,
  type WalletConnection,
} from "./wallet";
import { bindWalletToIdentity, loadBinding, type WalletBinding } from "./binding";

// The MWA session (account + auth token) is cached so a restart does not leave the UI
// looking connected while every signing call fails for want of a token. MWA's guidance is
// to keep the auth token and reauthorize with it. Native only: MWA does not run on web.
const SESSION_KEY = "bond.wallet.session";

interface StoredSession {
  address: string;
  addressBase64: string;
  authToken: string;
  label: string | null;
}

async function saveSession(session: StoredSession | null): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    if (session) await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session));
    else await SecureStore.deleteItemAsync(SESSION_KEY);
  } catch {
    // Best effort: an uncached session only means the user reconnects after a restart.
  }
}

export async function loadSession(): Promise<StoredSession | null> {
  if (Platform.OS === "web") return null;
  try {
    const raw = await SecureStore.getItemAsync(SESSION_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof v.address !== "string" || typeof v.addressBase64 !== "string" || typeof v.authToken !== "string") {
      return null;
    }
    return { address: v.address, addressBase64: v.addressBase64, authToken: v.authToken, label: v.label ?? null };
  } catch {
    return null;
  }
}

function errorMessage(e: unknown): string {
  return String((e as Error)?.message ?? e);
}

export interface WalletStoreState {
  /** True only on Android, where MWA can run. The UI degrades gracefully elsewhere. */
  available: boolean;
  connecting: boolean;
  connectedAddress: string | null;
  addressBase64: string | null;
  authToken: string | null;
  label: string | null;
  binding: WalletBinding | null;
  error: string | null;

  connect: () => Promise<WalletConnection | null>;
  disconnect: () => Promise<void>;
  reconnect: () => Promise<void>;
  bindIdentity: (did: string) => Promise<WalletBinding | null>;
  loadStoredBinding: (did: string) => Promise<void>;
  /** Restore the cached MWA session at startup. Safe to call more than once. */
  restoreSession: () => Promise<void>;
  clearError: () => void;
}

export const useWallet = create<WalletStoreState>((set, get) => ({
  available: isWalletAvailable(),
  connecting: false,
  connectedAddress: null,
  addressBase64: null,
  authToken: null,
  label: null,
  binding: null,
  error: null,

  connect: async () => {
    if (!isWalletAvailable()) {
      set({ error: "Wallet is Android-only. Connect a Seeker wallet on an Android device." });
      return null;
    }
    set({ connecting: true, error: null });
    try {
      const conn = await connectWallet();
      set({
        connectedAddress: conn.address,
        addressBase64: conn.addressBase64,
        authToken: conn.authToken,
        label: conn.label ?? null,
        connecting: false,
      });
      await saveSession({ address: conn.address, addressBase64: conn.addressBase64, authToken: conn.authToken, label: conn.label ?? null });
      return conn;
    } catch (e) {
      set({ connecting: false, error: errorMessage(e) });
      return null;
    }
  },

  disconnect: async () => {
    const token = get().authToken;
    if (token) {
      try {
        await disconnectWallet(token);
      } catch {
        // Deauthorize is best-effort. Clear local state regardless.
      }
    }
    set({
      connectedAddress: null,
      addressBase64: null,
      authToken: null,
      label: null,
      binding: null,
    });
    await saveSession(null);
  },

  reconnect: async () => {
    const token = get().authToken;
    if (!token || !isWalletAvailable()) return;
    set({ connecting: true, error: null });
    try {
      const conn = await reauthorize(token);
      await saveSession({ address: conn.address, addressBase64: conn.addressBase64, authToken: conn.authToken, label: conn.label ?? null });
      set({
        connectedAddress: conn.address,
        addressBase64: conn.addressBase64,
        authToken: conn.authToken,
        label: conn.label ?? null,
        connecting: false,
      });
    } catch (e) {
      set({ connecting: false, error: errorMessage(e) });
    }
  },

  bindIdentity: async (did) => {
    const { connectedAddress, addressBase64, authToken, label } = get();
    try {
      const connection: WalletConnection | undefined =
        connectedAddress && addressBase64 && authToken
          ? { address: connectedAddress, addressBase64, authToken, label: label ?? undefined }
          : undefined;
      const binding = await bindWalletToIdentity(did, connection);
      set({ binding, connectedAddress: binding.walletAddress });
      return binding;
    } catch (e) {
      set({ error: errorMessage(e) });
      return null;
    }
  },

  loadStoredBinding: async (did) => {
    // Restore the cached MWA session first, so "connected" always carries a usable token.
    await get().restoreSession();
    try {
      const binding = await loadBinding(did);
      if (binding) {
        // A binding is proof of past ownership, not a live session: it never fills in
        // connectedAddress on its own, or the UI would offer actions it cannot sign.
        set({ binding });
      }
    } catch {
      // Secure storage is unavailable on this platform. Leave state untouched.
    }
  },

  restoreSession: async () => {
    const session = await loadSession();
    if (session && !get().authToken) {
      set({
        connectedAddress: session.address,
        addressBase64: session.addressBase64,
        authToken: session.authToken,
        label: session.label,
      });
    }
  },

  clearError: () => set({ error: null }),
}));
