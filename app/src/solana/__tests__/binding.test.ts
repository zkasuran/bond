// The binding challenge and its verification are pure crypto over the same Ed25519 keys the
// device already uses, so these run without any wallet or web3 import. expo-secure-store is
// mocked so importing the module does not require a native store. The round trip proves a
// signature made by a key verifies against that key's Solana address and fails for a tampered
// challenge or a different key.
jest.mock("expo-secure-store", () => ({
  setItemAsync: jest.fn(async () => undefined),
  getItemAsync: jest.fn(async () => null),
  deleteItemAsync: jest.fn(async () => undefined),
}));

import {
  bindingMessageBytes,
  buildBindingMessage,
  extractSignature,
  verifyBinding,
  type BindingChallenge,
} from "../binding";
import { generateKeypair, publicKeyToSolanaAddress, signBytes } from "../../identity/keys";

function makeChallenge(walletAddress: string): BindingChallenge {
  return {
    did: "did:key:zTestDeviceIdentity",
    walletAddress,
    nonce: "abc123",
    issuedAt: "2026-09-23T00:00:00.000Z",
  };
}

describe("binding challenge message", () => {
  it("names the did, the wallet and the nonce, deterministically", () => {
    const challenge = makeChallenge("Wallet1111111111111111111111111111111111111");
    const message = buildBindingMessage(challenge);
    expect(message).toContain("did:key:zTestDeviceIdentity");
    expect(message).toContain("Wallet1111111111111111111111111111111111111");
    expect(message).toContain("abc123");
    expect(buildBindingMessage(challenge)).toBe(message);
  });
});

describe("verifyBinding", () => {
  it("accepts a signature the wallet key made over the challenge", () => {
    const kp = generateKeypair();
    const challenge = makeChallenge(publicKeyToSolanaAddress(kp.publicKey));
    const signature = signBytes(bindingMessageBytes(challenge), kp.secretKey);
    expect(verifyBinding(challenge, signature)).toBe(true);
  });

  it("rejects a signature over a tampered challenge", () => {
    const kp = generateKeypair();
    const challenge = makeChallenge(publicKeyToSolanaAddress(kp.publicKey));
    const signature = signBytes(bindingMessageBytes(challenge), kp.secretKey);
    expect(verifyBinding({ ...challenge, nonce: "different" }, signature)).toBe(false);
  });

  it("rejects a signature from a different key", () => {
    const kp = generateKeypair();
    const other = generateKeypair();
    const challenge = makeChallenge(publicKeyToSolanaAddress(kp.publicKey));
    const signature = signBytes(bindingMessageBytes(challenge), other.secretKey);
    expect(verifyBinding(challenge, signature)).toBe(false);
  });
});

describe("extractSignature", () => {
  it("takes the trailing 64 bytes of a message plus signature payload", () => {
    const message = new Uint8Array(20).fill(7);
    const signature = new Uint8Array(64).fill(9);
    const payload = new Uint8Array([...message, ...signature]);
    expect(Array.from(extractSignature(payload))).toEqual(Array.from(signature));
  });

  it("returns a bare 64-byte signature unchanged", () => {
    const signature = new Uint8Array(64).fill(3);
    expect(Array.from(extractSignature(signature))).toEqual(Array.from(signature));
  });

  it("throws on a payload too short to hold a signature", () => {
    expect(() => extractSignature(new Uint8Array(10))).toThrow();
  });
});
