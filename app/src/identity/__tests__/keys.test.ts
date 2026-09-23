import {
  generateKeypair,
  publicKeyToDid,
  publicKeyToSolanaAddress,
  solanaAddressToPublicKey,
  didToSolanaAddress,
  didToPublicKey,
} from "../keys";

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
});
