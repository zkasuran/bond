// A Solana Explorer deep link for a transaction signature. Pure string building, so it
// loads anywhere and is shared by the wallet screen, the market proof, the in-thread
// payment receipt card and the tests. Devnet and testnet carry the cluster query the
// explorer needs; mainnet is the bare path. The signature is URL encoded so a hostile or
// malformed value can never break out of the query.
export type ExplorerCluster = "devnet" | "mainnet-beta" | "testnet";

export function explorerTxUrl(signature: string, cluster: ExplorerCluster = "devnet"): string {
  const base = `https://explorer.solana.com/tx/${encodeURIComponent(signature)}`;
  if (cluster === "mainnet-beta") return base;
  const name = cluster === "testnet" ? "testnet" : "devnet";
  return `${base}?cluster=${name}`;
}
