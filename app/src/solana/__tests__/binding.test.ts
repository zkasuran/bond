// The binding ties the device did:key to the connected Seeker wallet. It must be TWO-sided:
// the wallet signs AND the device did:key counter-signs the same challenge, so a wallet
// alone cannot mint a binding for a did it does not control. These run as pure crypto over
// the Ed25519 keys the device already uses, with expo-secure-store mocked.
jest.mock("expo-secure-store", () => ({
  setItemAsync: jest.fn(async () => undefined),
  getItemAsync: jest.fn(async () => null),
  deleteItemAsync: jest.fn(async () => undefined),
}));

import * as SecureStore from "expo-secure-store";
import { base64urlnopad } from "@scure/base";
import {
  BINDING_CONTEXT,
  bindingKey,
  bindingMessageBytes,
  buildBindingMessage,
  extractSignature,
  loadBinding,
  saveBinding,
  verifyBinding,
  type BindingChallenge,
  type WalletBinding,
} from "../binding";
import { generateKeypair, publicKeyToDid, publicKeyToSolanaAddress, signBytes } from "../../identity/keys";

const getItem = SecureStore.getItemAsync as jest.Mock;
const setItem = SecureStore.setItemAsync as jest.Mock;

function sign(challenge: BindingChallenge, secret: Uint8Array): string {
  return base64urlnopad.encode(signBytes(bindingMessageBytes(challenge), secret));
}

/** A correct, fully two-sided binding: the wallet key signs and the device did:key signs. */
function twoSided(over: Partial<BindingChallenge> = {}) {
  const walletKp = generateKeypair();
  const deviceKp = generateKeypair();
  const now = Date.now();
  const challenge: BindingChallenge = {
    did: publicKeyToDid(deviceKp.publicKey),
    walletAddress: publicKeyToSolanaAddress(walletKp.publicKey),
    nonce: "abc123",
    context: BINDING_CONTEXT,
    version: 1,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
    ...over,
  };
  const binding: WalletBinding = {
    ...challenge,
    walletSignature: sign(challenge, walletKp.secretKey),
    didSignature: sign(challenge, deviceKp.secretKey),
    boundAt: new Date(now).toISOString(),
  };
  return { binding, walletKp, deviceKp };
}

/** A two-sided binding for a FIXED device (so the did is stable across versions), with a
 *  fresh wallet each call. Used to model a legitimate rebind to a new wallet at version N. */
function twoSidedForDevice(deviceKp: ReturnType<typeof generateKeypair>, version: number) {
  const walletKp = generateKeypair();
  const now = Date.now();
  const challenge: BindingChallenge = {
    did: publicKeyToDid(deviceKp.publicKey),
    walletAddress: publicKeyToSolanaAddress(walletKp.publicKey),
    nonce: "nonce-" + version,
    context: BINDING_CONTEXT,
    version,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
  };
  const binding: WalletBinding = {
    ...challenge,
    walletSignature: sign(challenge, walletKp.secretKey),
    didSignature: sign(challenge, deviceKp.secretKey),
    boundAt: new Date(now).toISOString(),
  };
  return { binding, walletKp };
}

beforeEach(() => {
  getItem.mockReset();
  setItem.mockReset();
  getItem.mockResolvedValue(null);
  setItem.mockResolvedValue(undefined);
});

describe("binding challenge message", () => {
  it("commits to the did, the wallet, the nonce, the context and the expiry", () => {
    const { binding } = twoSided();
    const message = buildBindingMessage(binding);
    expect(message).toContain(binding.did);
    expect(message).toContain(binding.walletAddress);
    expect(message).toContain("abc123");
    expect(message).toContain(BINDING_CONTEXT);
    expect(message).toContain(binding.expiresAt);
    expect(buildBindingMessage(binding)).toBe(message);
  });
});

describe("verifyBinding (two-sided)", () => {
  it("accepts a binding both the wallet and the did signed", () => {
    const { binding } = twoSided();
    expect(verifyBinding(binding, 1)).toBe(true);
  });

  it("rejects a binding the did did not sign, so a wallet cannot bind a victim did", () => {
    // Mallory controls her own wallet and signs a challenge naming the victim's did. She
    // cannot produce the victim did's counter-signature, so the binding must not verify.
    const victimDevice = generateKeypair();
    const malloryWallet = generateKeypair();
    const mallory = generateKeypair();
    const now = Date.now();
    const challenge: BindingChallenge = {
      did: publicKeyToDid(victimDevice.publicKey),
      walletAddress: publicKeyToSolanaAddress(malloryWallet.publicKey),
      nonce: "forge",
      context: BINDING_CONTEXT,
      version: 1,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 3_600_000).toISOString(),
    };
    const forged: WalletBinding = {
      ...challenge,
      walletSignature: sign(challenge, malloryWallet.secretKey), // valid wallet signature
      didSignature: sign(challenge, mallory.secretKey), // NOT the victim did's key
      boundAt: new Date(now).toISOString(),
    };
    expect(verifyBinding(forged, 1)).toBe(false);
  });

  it("rejects a binding with no did signature", () => {
    const { binding } = twoSided();
    expect(verifyBinding({ ...binding, didSignature: "" }, 1)).toBe(false);
  });

  it("rejects a binding whose wallet address was swapped after signing", () => {
    const { binding } = twoSided();
    const other = publicKeyToSolanaAddress(generateKeypair().publicKey);
    expect(verifyBinding({ ...binding, walletAddress: other }, 1)).toBe(false);
  });

  it("accepts a fresh binding but rejects the same binding once expired", () => {
    const fresh = twoSided().binding;
    expect(verifyBinding(fresh, 1)).toBe(true);
    const past = Date.now() - 10_000;
    const stale = twoSided({
      issuedAt: new Date(past - 3_600_000).toISOString(),
      expiresAt: new Date(past).toISOString(),
    }).binding;
    expect(verifyBinding(stale, 1)).toBe(false);
  });

  it("rejects a binding whose context tag does not match the pinned one", () => {
    const { binding } = twoSided({ context: "someone-elses-app" });
    expect(verifyBinding(binding, 1, { context: BINDING_CONTEXT })).toBe(false);
  });
});

describe("loadBinding re-verifies before trusting", () => {
  it("returns a stored binding that still verifies", async () => {
    const { binding } = twoSided();
    getItem.mockResolvedValueOnce(JSON.stringify(binding));
    const out = await loadBinding(binding.did);
    expect(out?.walletAddress).toBe(binding.walletAddress);
  });

  it("drops a stored binding whose wallet address was tampered", async () => {
    const { binding } = twoSided();
    const tampered = { ...binding, walletAddress: publicKeyToSolanaAddress(generateKeypair().publicKey) };
    getItem.mockResolvedValueOnce(JSON.stringify(tampered));
    expect(await loadBinding(binding.did)).toBeNull();
  });
});

describe("saveBinding guards a rebind", () => {
  it("stores a first binding when none exists", async () => {
    const { binding } = twoSided();
    await saveBinding(binding);
    expect(setItem).toHaveBeenCalledWith(bindingKey(binding.did), JSON.stringify(binding));
  });

  it("refuses to overwrite a valid binding with a non-superseding version", async () => {
    const { binding } = twoSided({ version: 2 });
    getItem.mockResolvedValueOnce(JSON.stringify(binding));
    const same = twoSided({ version: 2 }).binding;
    await expect(saveBinding(same)).rejects.toThrow();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("refuses a silent rebind to a different wallet without explicit consent", async () => {
    const existing = twoSided({ version: 1 }).binding;
    getItem.mockResolvedValue(JSON.stringify(existing));
    const other = twoSided({ did: existing.did, version: 2 }).binding;
    await expect(saveBinding(other)).rejects.toThrow();
    await saveBinding(other, { allowRebind: true });
    expect(setItem).toHaveBeenCalledWith(bindingKey(other.did), JSON.stringify(other));
  });
});

describe("extractSignature", () => {
  it("takes the trailing 64 bytes of a message plus signature payload", () => {
    const message = new Uint8Array(20).fill(7);
    const signature = new Uint8Array(64).fill(9);
    const payload = new Uint8Array([...message, ...signature]);
    expect(Array.from(extractSignature(payload))).toEqual(Array.from(signature));
  });

  it("throws on a payload too short to hold a signature", () => {
    expect(() => extractSignature(new Uint8Array(10))).toThrow();
  });
});

describe("replay and downgrade are refused in the trust path (GAP 2)", () => {
  it("refuses a re-planted older binding on load after a rebind (GAP 2)", async () => {
    // V6: a genuinely signed but superseded v1 binding, re-planted into the store after a
    // v2 rebind, must be refused on READ via the monotonic version floor, not only blocked
    // at write. Before the fix loadBinding re-verifies the real v1 and returns it, so the
    // did's USDC would route back to the stale wallet.
    const store = new Map<string, string>();
    getItem.mockImplementation(async (k: string) => store.get(k) ?? null);
    setItem.mockImplementation(async (k: string, v: string) => {
      store.set(k, v);
    });

    const device = generateKeypair();
    const did = publicKeyToDid(device.publicKey);
    const v1 = twoSidedForDevice(device, 1).binding;
    const v2 = twoSidedForDevice(device, 2).binding;
    await saveBinding(v1);
    await saveBinding(v2, { allowRebind: true });

    // The attacker overwrites the binding slot with the genuine, superseded v1.
    const slot = [...store.keys()].find((k) => k.startsWith("bond.walletBinding."));
    expect(slot).toBeDefined();
    store.set(slot as string, JSON.stringify(v1));

    expect(await loadBinding(did)).toBeNull();
  });

  it("verifyBinding rejects a version below the expected (GAP 2)", () => {
    // A remote verifier that tracks the current version must be able to refuse a downgrade.
    const device = generateKeypair();
    const v1 = twoSidedForDevice(device, 1).binding;
    expect(verifyBinding(v1, 1)).toBe(true); // meets the expected floor
    expect(verifyBinding(v1, 2)).toBe(false); // below the expected floor, refused
  });
});
