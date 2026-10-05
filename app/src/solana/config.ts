// Solana network + token constants for Bond on Seeker. One place for the mints, the
// decimals, the RPC endpoints and the Mobile Wallet Adapter identity so the wallet
// module, the USDC builder, the swap client and the screen all agree. Nothing here
// touches native code, so it loads on web and under jest. getConnection is the only
// function that constructs a web3.js Connection. It runs on demand, not at import.
import { Connection, type Cluster } from "@solana/web3.js";

/** The cluster Bond transacts on by default. Payments and the marketplace run on
 *  devnet USDC so nothing needs real funds. Jupiter is mainnet-only (see swap.ts). */
export const SOLANA_CLUSTER: Cluster = "devnet";

export const DEVNET_RPC = "https://api.devnet.solana.com";
export const MAINNET_RPC = "https://api.mainnet-beta.solana.com";

/** Devnet USDC. 6 decimals, the standard for USDC on every cluster. */
export const USDC_DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
/** Mainnet USDC, used only to price and label Jupiter quotes. */
export const USDC_MAINNET_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;

/** SKR, Seeker's token on Solana. A classic SPL Token (owner TokenkegQfe...), 6 decimals,
 *  mainnet only: it does not exist on devnet. Bond reads it live from mainnet for a holder
 *  balance and a price, the same read-only class as a Jupiter mainnet quote. No SKR ever
 *  moves and nothing is signed against it; skill purchases still settle in devnet USDC. */
export const SKR_MINT = "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3";
export const SKR_DECIMALS = 6;

/** Wrapped SOL, the input side of a SOL to USDC swap quote. */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const SOL_DECIMALS = 9;
export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Jupiter free tier host. The quote endpoint is a plain GET so it works anywhere.
 *  Execution is mainnet-only and needs real funds, so it stays gated in the UI. */
export const JUPITER_LITE_API = "https://lite-api.jup.ag/swap/v1";

/** The chain string MWA 2.0 authorize() expects for devnet. */
export const MWA_CHAIN = "solana:devnet";

/** How Bond identifies itself to the wallet in the MWA authorize prompt. */
export const APP_IDENTITY = {
  name: "Bond",
  uri: "https://bond.zkasuran.dev",
  icon: "favicon.ico",
} as const;

/** A web3.js Connection for the given cluster. Built on demand, never at import, so a
 *  test that mocks @solana/web3.js is never forced to construct a real one. */
export function getConnection(cluster: Cluster = SOLANA_CLUSTER): Connection {
  const rpc = cluster === "mainnet-beta" ? MAINNET_RPC : DEVNET_RPC;
  return new Connection(rpc, "confirmed");
}
