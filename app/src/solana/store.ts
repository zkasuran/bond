// Self-contained wallet store. Separate from the main Bond engine store (state/store.ts) on
// purpose: wallet state is Android-only and optional, so it lives on its own and the rest of
// the app does not depend on it. Holds the connected address, the MWA auth token and the
// identity binding. Actions wrap solana/wallet.ts and solana/binding.ts and never throw:
// failures land in `error` so the UI can show them.
import { create } from "zustand";
import {
  connectWallet,
  disconnectWallet,
  isWalletAvailable,
  reauthorize,
  type WalletConnection,
} from "./wallet";
import { bindWalletToIdentity, loadBinding, type WalletBinding } from "./binding";

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
  },

  reconnect: async () => {
    const token = get().authToken;
    if (!token || !isWalletAvailable()) return;
    set({ connecting: true, error: null });
    try {
      const conn = await reauthorize(token);
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
    try {
      const binding = await loadBinding(did);
      if (binding) {
        set((s) => ({ binding, connectedAddress: s.connectedAddress ?? binding.walletAddress }));
      }
    } catch {
      // Secure storage is unavailable on this platform. Leave state untouched.
    }
  },

  clearError: () => set({ error: null }),
}));
