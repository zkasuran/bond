// The wallet store caches the MWA session so a restart does not leave the UI showing a
// connected wallet with no auth token to sign with (a bug the e2e run on the emulator hit:
// the pay sheet showed "From <address>" but the payment failed for want of a token). It also
// refuses to adopt a connected wallet that does not match the bound identity, and a bind
// persists the full session it signed with, not just the address.
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
  setSessionRenewedListener: jest.fn(),
}));
jest.mock("../binding", () => ({
  bindWalletToIdentity: jest.fn(async () => ({
    binding: { did: "did:key:z6MkDevice", walletAddress: "BoundWallet1111111111111111111111111111111", version: 1 },
    connection: { address: "BoundWallet1111111111111111111111111111111", addressBase64: "CCCC", authToken: "bind-token", label: "bound" },
  })),
  loadBinding: jest.fn(async () => ({ walletAddress: "Hk26Gxs8zrZ5dCfBQsePwpzZpYvXLDx5A3GrrMhBZYW9" })),
}));
jest.mock("../../identity/storage", () => ({
  loadOrCreateIdentity: jest.fn(async () => ({
    identity: { did: "did:key:z6MkDevice", displayName: "You", kind: "human" },
    secretKey: new Uint8Array(32).fill(9),
    assurance: "device",
  })),
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

it("refuses to adopt a connected wallet that does not match the bound identity", async () => {
  // F09 MED: the device is bound to one wallet. A connect that returns a different account
  // must not seat that account as "you".
  useWallet.setState({ binding: { walletAddress: "DifferentWallet99999999999999999999999999999" } as never });
  const conn = await useWallet.getState().connect();
  expect(conn).toBeNull();
  const s = useWallet.getState();
  expect(s.connectedAddress).toBeNull();
  expect(s.error).toMatch(/bound|match/i);
});

it("connect still succeeds when the connected wallet matches the binding", async () => {
  useWallet.setState({ binding: { walletAddress: "Hk26Gxs8zrZ5dCfBQsePwpzZpYvXLDx5A3GrrMhBZYW9" } as never });
  const conn = await useWallet.getState().connect();
  expect(conn).not.toBeNull();
  expect(useWallet.getState().authToken).toBe("token-1");
});

it("bindIdentity persists the full session it bound, not only the address", async () => {
  // F09 MED: binding must leave a live token behind, else the UI shows "connected" while the
  // next signing call replays a null token and triggers the fallback path.
  const binding = await useWallet.getState().bindIdentity("did:key:z6MkDevice");
  expect(binding).not.toBeNull();
  const s = useWallet.getState();
  expect(s.connectedAddress).toBe("BoundWallet1111111111111111111111111111111");
  expect(s.authToken).toBe("bind-token");
  expect(s.addressBase64).toBe("CCCC");
});

it("bindIdentity refuses a did that is not this device's own identity", async () => {
  const r = await useWallet.getState().bindIdentity("did:key:z6MkSomeoneElse");
  expect(r).toBeNull();
  expect(useWallet.getState().error).toMatch(/own identity|device/i);
});

it("adopts a session renewed during a signing call and caches it", async () => {
  const { setSessionRenewedListener } = jest.requireMock("../wallet") as { setSessionRenewedListener: jest.Mock };
  const listener = setSessionRenewedListener.mock.calls[0]?.[0] as (c: unknown) => void;
  expect(typeof listener).toBe("function");
  listener({ address: "NEWaddress", addressBase64: "BBBB", authToken: "token-2", label: "w" });
  expect(useWallet.getState().authToken).toBe("token-2");
  await new Promise((r) => setImmediate(r));
  useWallet.setState(blank);
  await useWallet.getState().restoreSession();
  expect(useWallet.getState().authToken).toBe("token-2");
});
