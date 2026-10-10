import {
  generateKeypair,
  publicKeyToDid,
  publicKeyToSolanaAddress,
  solanaAddressToPublicKey,
  didToSolanaAddress,
  didToPublicKey,
  keypairFromStoredSecret,
} from "../keys";
import { base58, base64urlnopad } from "@scure/base";

// Solana keys are Ed25519, the same primitive bond already uses for did:key. The
// address is just base58 of the bare 32-byte public key (did:key adds a multicodec
// prefix; the Solana address drops it). These helpers make one identity serve as both.
describe("solana address helpers", () => {
  it("round-trips a public key through its base58 Solana address", () => {
    const { publicKey } = generateKeypair();
    const address = publicKeyToSolanaAddress(publicKey);
    expect(typeof address).toBe("string");
    expect(address.length).toBeGreaterThan(30);
    expect(solanaAddressToPublicKey(address)).toEqual(publicKey);
  });

  it("derives the same Solana address from the did as from the public key", () => {
    const { publicKey, did } = generateKeypair();
    expect(didToSolanaAddress(did)).toBe(publicKeyToSolanaAddress(publicKey));
    expect(didToPublicKey(did)).toEqual(publicKey);
  });

  it("the did and the Solana address encode the same key in different forms", () => {
    const { publicKey } = generateKeypair();
    const did = publicKeyToDid(publicKey);
    const address = publicKeyToSolanaAddress(publicKey);
    expect(did.startsWith("did:key:z")).toBe(true);
    expect(did).not.toBe(address);
    expect(solanaAddressToPublicKey(address)).toEqual(didToPublicKey(did));
  });

  it("rejects an address that is not a 32-byte key", () => {
    expect(() => solanaAddressToPublicKey("abc")).toThrow();
  });

  it("rejects a did:key whose ed25519 body is not 32 bytes", () => {
    // A hostile peer sends the ed25519 multicodec prefix with a short body. The parse must
    // reject it, the same way solanaAddressToPublicKey rejects a non-32-byte address, rather
    // than passing a malformed key into a display or transfer path.
    const malformed = new Uint8Array(2 + 31);
    malformed[0] = 0xed;
    malformed[1] = 0x01;
    const badDid = "did:key:z" + base58.encode(malformed);
    expect(() => didToPublicKey(badDid)).toThrow();
    expect(() => didToSolanaAddress(badDid)).toThrow();
  });
});

describe("stored secret validation", () => {
  it("reconstructs a keypair from a valid stored secret", () => {
    const kp = generateKeypair();
    const back = keypairFromStoredSecret(base64urlnopad.encode(kp.secretKey));
    expect(back).not.toBeNull();
    expect(back!.did).toBe(kp.did);
  });

  it("returns null for a secret that is not valid base64url", () => {
    expect(keypairFromStoredSecret("not valid base64url %%%")).toBeNull();
  });

  it("returns null for a secret of the wrong length", () => {
    expect(keypairFromStoredSecret(base64urlnopad.encode(new Uint8Array(31)))).toBeNull();
  });
});
