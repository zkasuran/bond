// A wallet can revoke or expire Bond's auth token (MWA error -1). Found on device: a
// purchase failed with "authorization request failed". A privileged call falls back to a
// fresh authorize inside the same session, but only on that specific token condition, and
// never adopts a different account for an action the user built against the old one.
jest.mock("../config", () => ({ APP_IDENTITY: { name: "Bond", uri: "https://bond.zkasuran.dev" }, MWA_CHAIN: "solana:devnet" }));
// The native MWA module is loaded by a dynamic import inside the send path. Mock it so the
// module graph resolves under jest; the fail-closed fee-payer check runs before it is reached.
const mockNativeTransact = jest.fn(async (cb: (w: unknown) => unknown) => cb({}));
jest.mock("@solana-mobile/mobile-wallet-adapter-protocol-web3js", () => ({
  transact: (cb: (w: unknown) => unknown) => mockNativeTransact(cb),
}));
import type { Transaction } from "@solana/web3.js";
import { Platform } from "react-native";
import { reauthorizeOrAuthorize, setSessionRenewedListener, signAndSendTransaction } from "../wallet";
import { publicKeyToSolanaAddress } from "../../identity/keys";

const acct = (b64: string) => ({ accounts: [{ address: b64, label: "w" }], auth_token: `tok-${b64}` });
const ADDR = Buffer.alloc(32, 1).toString("base64");
const NEW = Buffer.alloc(32, 2).toString("base64");
const SHORT = Buffer.alloc(20, 1).toString("base64");
const addrOf = (b64: string) => publicKeyToSolanaAddress(Uint8Array.from(Buffer.from(b64, "base64")));
const tokenInvalid = () => Object.assign(new Error("-1: authorization request failed"), { code: -1 });

beforeEach(() => setSessionRenewedListener(() => {}));

it("replays a live token without re-prompting", async () => {
  const wallet = { reauthorize: jest.fn(async () => acct(ADDR)), authorize: jest.fn() };
  const renewed = jest.fn();
  setSessionRenewedListener(renewed);
  const conn = await reauthorizeOrAuthorize(wallet, "tok");
  expect(conn.addressBase64).toBe(ADDR);
  expect(wallet.authorize).not.toHaveBeenCalled();
  expect(renewed).not.toHaveBeenCalled();
});

it("falls back to authorize when the token was revoked and the account is unchanged", async () => {
  const wallet = {
    reauthorize: jest.fn(async () => {
      throw tokenInvalid();
    }),
    authorize: jest.fn(async () => acct(ADDR)),
  };
  const renewed = jest.fn();
  setSessionRenewedListener(renewed);
  const conn = await reauthorizeOrAuthorize(wallet, "dead", addrOf(ADDR));
  expect(conn.authToken).toBe(`tok-${ADDR}`);
  expect(renewed).toHaveBeenCalledWith(expect.objectContaining({ authToken: `tok-${ADDR}` }));
});

it("does NOT adopt a new account when the revoked-token fallback returns a different wallet", async () => {
  // F09 HIGH: the action was built for ADDR. A fallback that returns NEW must abort, not
  // silently swap the payer and send the pre-built transaction to a different account.
  const wallet = {
    reauthorize: jest.fn(async () => {
      throw tokenInvalid();
    }),
    authorize: jest.fn(async () => acct(NEW)),
  };
  const renewed = jest.fn();
  setSessionRenewedListener(renewed);
  await expect(reauthorizeOrAuthorize(wallet, "dead", addrOf(ADDR))).rejects.toMatchObject({
    name: "WalletAccountChangedError",
  });
  expect(renewed).not.toHaveBeenCalled();
});

it("does NOT adopt a new account when reauthorize itself returns a different wallet", async () => {
  const wallet = { reauthorize: jest.fn(async () => acct(NEW)), authorize: jest.fn() };
  await expect(reauthorizeOrAuthorize(wallet, "tok", addrOf(ADDR))).rejects.toMatchObject({
    name: "WalletAccountChangedError",
  });
  expect(wallet.authorize).not.toHaveBeenCalled();
});

it("rethrows a non-token reauthorize error instead of forcing a fresh authorize", async () => {
  // F09 MED: a user cancel, a network blip or a wallet-busy error must not escalate to a
  // full authorize sheet. Only the revoked or expired token condition falls back.
  const wallet = {
    reauthorize: jest.fn(async () => {
      throw new Error("User declined the request");
    }),
    authorize: jest.fn(async () => acct(NEW)),
  };
  await expect(reauthorizeOrAuthorize(wallet, "tok", addrOf(ADDR))).rejects.toThrow("declined");
  expect(wallet.authorize).not.toHaveBeenCalled();
});

it("still fails when the user declines the fresh authorization", async () => {
  const wallet = {
    reauthorize: jest.fn(async () => {
      throw tokenInvalid();
    }),
    authorize: jest.fn(async () => {
      throw new Error("declined");
    }),
  };
  await expect(reauthorizeOrAuthorize(wallet, "dead")).rejects.toThrow("declined");
});

it("rejects a wallet account whose address is not 32 bytes", async () => {
  // F09 MED: a non-32-byte address must be rejected at decode, not stored as a bogus
  // Solana address that only fails deep in a later transfer build.
  const wallet = { reauthorize: jest.fn(async () => acct(SHORT)), authorize: jest.fn() };
  await expect(reauthorizeOrAuthorize(wallet, "tok")).rejects.toThrow(/32-byte/);
});

it("refuses to send a transaction whose fee payer cannot be read (GAP 1 fail closed)", async () => {
  // V5: with an indeterminate fee payer there is no approved account to compare the
  // reauthorized signer against, so the account-swap guard cannot fire. The send must be
  // refused. Before the fix the call passes `feePayer ?? undefined` and proceeds toward the
  // send unguarded; after the fix it throws before any wallet is loaded or any send happens.
  const prevOS = Platform.OS;
  (Platform as { OS: string }).OS = "android";
  try {
    mockNativeTransact.mockClear();
    const noFeePayerTx = {} as unknown as Transaction; // no legacy feePayer, no versioned message
    await expect(signAndSendTransaction(noFeePayerTx, { authToken: "dead" })).rejects.toThrow(/fee payer/i);
    expect(mockNativeTransact).not.toHaveBeenCalled();
  } finally {
    (Platform as { OS: string }).OS = prevOS;
  }
});
