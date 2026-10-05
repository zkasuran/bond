// A wallet can revoke or expire Bond's auth token (MWA error -1). Found on device: a
// purchase failed with "authorization request failed". Privileged calls now fall back to a
// fresh authorize inside the same session, and the new session is handed to the store.
jest.mock("../config", () => ({ APP_IDENTITY: { name: "Bond", uri: "https://bond.zkasuran.dev" }, MWA_CHAIN: "solana:devnet" }));
import { reauthorizeOrAuthorize, setSessionRenewedListener } from "../wallet";

const acct = (b64: string) => ({ accounts: [{ address: b64, label: "w" }], auth_token: `tok-${b64}` });
const ADDR = Buffer.alloc(32, 1).toString("base64");
const NEW = Buffer.alloc(32, 2).toString("base64");

it("replays a live token without re-prompting", async () => {
  const wallet = { reauthorize: jest.fn(async () => acct(ADDR)), authorize: jest.fn() };
  const renewed = jest.fn();
  setSessionRenewedListener(renewed);
  const conn = await reauthorizeOrAuthorize(wallet, "tok");
  expect(conn.addressBase64).toBe(ADDR);
  expect(wallet.authorize).not.toHaveBeenCalled();
  expect(renewed).not.toHaveBeenCalled();
});

it("falls back to authorize when the token was revoked, and reports the new session", async () => {
  const wallet = {
    reauthorize: jest.fn(async () => {
      throw new Error("-1/authorization request failed");
    }),
    authorize: jest.fn(async () => acct(NEW)),
  };
  const renewed = jest.fn();
  setSessionRenewedListener(renewed);
  const conn = await reauthorizeOrAuthorize(wallet, "dead");
  expect(conn.authToken).toBe(`tok-${NEW}`);
  expect(renewed).toHaveBeenCalledWith(expect.objectContaining({ authToken: `tok-${NEW}` }));
});

it("still fails when the user declines the fresh authorization", async () => {
  const wallet = {
    reauthorize: jest.fn(async () => {
      throw new Error("revoked");
    }),
    authorize: jest.fn(async () => {
      throw new Error("declined");
    }),
  };
  await expect(reauthorizeOrAuthorize(wallet, "dead")).rejects.toThrow("declined");
});
