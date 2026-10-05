// On-chain confirmation for a submitted transfer. A signature from the wallet means the
// transaction was handed to the cluster, not that it landed, so the payment flow waits for
// this before it ever shows "confirmed". Kept out of usdc.ts so a caller can confirm any
// signature it holds. The Connection type is imported type-only, so this module pulls no
// web3.js runtime into a bundle that only wants the helper's signature.
import type { Connection, Commitment } from "@solana/web3.js";

export interface BlockhashContext {
  blockhash: string;
  lastValidBlockHeight: number;
}

/** Wait for `signature` to confirm against the blockhash it was built on. Throws when the
 *  cluster reports the transaction failed, so a caller never records a failed transfer as a
 *  confirmed one. Returns the signature on success so it can be chained. */
export async function confirmSignature(
  connection: Connection,
  signature: string,
  ctx: BlockhashContext,
  commitment: Commitment = "confirmed",
): Promise<string> {
  const result = await connection.confirmTransaction(
    { signature, blockhash: ctx.blockhash, lastValidBlockHeight: ctx.lastValidBlockHeight },
    commitment,
  );
  if (result?.value?.err) {
    throw new Error(`Transfer did not confirm on-chain: ${JSON.stringify(result.value.err)}`);
  }
  return signature;
}
