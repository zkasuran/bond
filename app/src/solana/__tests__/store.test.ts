// The wallet store caches the MWA session so a restart does not leave the UI showing a
// connected wallet with no auth token to sign with (a bug the e2e run on the emulator hit:
// the pay sheet showed "From <address>" but the payment failed for want of a token).
jest.mock("expo-secure-store", () => {
  const mem = new Map<string, string>();
  return {
    getItemAsync: jest.fn(async (k: string) => mem.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => {
      mem.set(k, v);
    }),
    deleteItemAsync: jest.fn(async (k: string) => {
      mem.delete(k);
    }),
    __mem: mem,
  };
});
jest.mock("../wallet", () => ({
  isWalletAvailable: () => true,
  connectWallet: jest.fn(async () => ({
    address: "Hk26Gxs8zrZ5dCfBQsePwpzZpYvXLDx5A3GrrMhBZYW9",
    addressBase64: "AAAA",
    authToken: "token-1",
    label: "fakewallet account 0",
  })),
  disconnectWallet: jest.fn(async () => {}),
  reauthorize: jest.fn(),
}));
jest.mock("../binding", () => ({
  bindWalletToIdentity: jest.fn(),
  loadBinding: jest.fn(async () => ({ walletAddress: "Hk26Gxs8zrZ5dCfBQsePwpzZpYvXLDx5A3GrrMhBZYW9" })),
}));

import * as SecureStore from "expo-secure-store";
import { useWallet } from "../store";

const mem = (SecureStore as unknown as { __mem: Map<string, string> }).__mem;
const blank = {
  connectedAddress: null,
  addressBase64: null,
  authToken: null,
  label: null,
  binding: null,
  error: null,
};

beforeEach(() => {
  mem.clear();
  useWallet.setState(blank);
});

it("connect caches the session and a restart restores it with its token", async () => {
  await useWallet.getState().connect();
  useWallet.setState(blank); // simulate an app restart
  await useWallet.getState().restoreSession();
  const s = useWallet.getState();
  expect(s.connectedAddress).toBe("Hk26Gxs8zrZ5dCfBQsePwpzZpYvXLDx5A3GrrMhBZYW9");
  expect(s.authToken).toBe("token-1");
});

it("disconnect forgets the cached session", async () => {
  await useWallet.getState().connect();
  await useWallet.getState().disconnect();
  useWallet.setState(blank);
  await useWallet.getState().restoreSession();
  expect(useWallet.getState().authToken).toBeNull();
});

it("a stored binding alone never marks the wallet connected", async () => {
  await useWallet.getState().loadStoredBinding("did:key:z6Mk");
  const s = useWallet.getState();
  expect(s.binding).not.toBeNull();
  expect(s.connectedAddress).toBeNull();
});

it("a corrupt cached session is ignored", async () => {
  mem.set("bond.wallet.session", "{not json");
  await useWallet.getState().restoreSession();
  expect(useWallet.getState().authToken).toBeNull();
});
