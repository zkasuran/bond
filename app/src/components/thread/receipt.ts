// Pure view-models for the in-thread message cards. Kept free of react-native and solana
// imports so they unit-test under node and so MessageNode stays a thin renderer over them.
// A payment node becomes a receipt (amount, asset, network, parties, status, explorer link)
// and a tool_call / tool_result becomes a tool chip plus a labeled card. The honesty labels
// (devnet, no real funds, agent-reported) live here so they cannot drift between code paths.
import type {
  ContentPart,
  PaymentPayload,
  ToolCallPayload,
  ToolResultPayload,
} from "@/model/messages";
import type { BondNode } from "@/model/node";
import { explorerTxUrl, type ExplorerCluster } from "@/solana/explorer";

/** Format an integer base-unit amount string with its decimals, without float rounding.
 *  Mirrors solana/usdc.fromBaseUnits but stays solana-free so this module imports nothing
 *  native. "2500000" at 6 decimals is "2.5"; trailing zeros drop; a bad value is "0". */
export function formatBaseUnits(amount: string, decimals: number): string {
  if (!/^\d+$/.test(amount) || !Number.isInteger(decimals) || decimals < 0) return "0";
  const padded = amount.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** Shorten a base58 address or signature for display, keeping the ends that identify it. */
export function shortMiddle(value: string, lead = 4, tail = 4): string {
  if (!value) return "";
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

export type ReceiptTone = "verified" | "warning" | "tampered" | "muted";

/** The outcome of re-checking a payment's signature on-chain on this device. A payment node
 *  arrives signed by its author but never chain-verified, so "unverified" is the default and
 *  the only state the renderer can assume without a real re-check (confirmSignature). */
export type ChainCheck = "verified" | "failed" | "unverified";

/** Shown on an unverified receipt so a peer's self-reported transfer is never read as a
 *  settlement. The payment analog of the tool card's agent-reported disclaimer. */
export const PAYMENT_CLAIM_DISCLAIMER = "Reported by the sender. Not re-checked on-chain.";

export interface PaymentView {
  amountDisplay: string;
  asset: string;
  /** Clean validated network name, used for the explorer link label. */
  networkLabel: string;
  /** The network chip text. Reads as a confident network only after a local on-chain
   *  re-check; otherwise it is marked unverified so a peer-set cluster is never a fact. */
  networkChip: string;
  from: string;
  to: string;
  fromShort: string;
  toShort: string;
  memo?: string;
  signature?: string;
  explorerUrl?: string;
  statusLabel: string;
  statusTone: ReceiptTone;
  /** The sender's self-reported status, straight from the signed-but-not-chain-checked
   *  payload. Never on its own a statement that the transfer settled. */
  claimedStatus: PaymentPayload["status"];
  /** True ONLY after a local on-chain re-check matched this transfer. Never derived from the
   *  attacker-set `status` field, so a peer cannot paint a receipt as confirmed. */
  confirmed: boolean;
  /** Present whenever the receipt is only the sender's claim, so the card can say so. */
  claimDisclaimer?: string;
  honesty: string;
}

/** The three clusters a payment node may legitimately name. Any other value is a hostile or
 *  malformed string and must never be echoed on the card as if it were a real network. */
const KNOWN_CLUSTERS: readonly PaymentPayload["cluster"][] = ["devnet", "mainnet-beta", "testnet"];

function isKnownCluster(cluster: unknown): cluster is PaymentPayload["cluster"] {
  return typeof cluster === "string" && (KNOWN_CLUSTERS as readonly string[]).includes(cluster);
}

/** Human label for a validated cluster. An unrecognized value reads as "unknown network"
 *  rather than echoing the attacker-set string. */
function clusterLabel(cluster: unknown): string {
  if (!isKnownCluster(cluster)) return "unknown network";
  return cluster === "mainnet-beta" ? "mainnet" : cluster;
}

/** The one-line honesty footer. The only line that asserts a real settled transfer
 *  ("On-chain transfer.") is reachable solely through a local on-chain re-check, so a peer
 *  who claims mainnet-beta without a re-check never prints a settlement. Devnet and testnet
 *  always read as no real funds, and an unrecognized network reads as unverified. */
function honestyLine(cluster: unknown, known: boolean, confirmed: boolean): string {
  if (!known) return "Unverified transfer. Network not recognized.";
  if (cluster === "mainnet-beta") {
    return confirmed ? "On-chain transfer." : "Claimed mainnet transfer, unverified.";
  }
  const net = cluster === "testnet" ? "Testnet" : "Devnet";
  return `${net} transfer. No real funds.`;
}

/** Resolve the pill from the local chain-check first, then fall back to the sender's claim.
 *  A green, settled "verified" tone is reachable only through a real on-chain re-check; a
 *  self-reported "confirmed" with no re-check reads as an unverified claim, never settled. */
function statusView(
  claimed: PaymentPayload["status"],
  chainCheck: ChainCheck,
): { label: string; tone: ReceiptTone; confirmed: boolean } {
  if (chainCheck === "verified") return { label: "Confirmed on-chain", tone: "verified", confirmed: true };
  if (chainCheck === "failed") return { label: "Failed on-chain", tone: "tampered", confirmed: false };
  switch (claimed) {
    case "failed":
      return { label: "Failed", tone: "tampered", confirmed: false };
    case "pending":
      return { label: "Pending", tone: "warning", confirmed: false };
    case "confirmed":
      return { label: "Claimed", tone: "muted", confirmed: false };
    default:
      return { label: "Proposed", tone: "muted", confirmed: false };
  }
}

/** Build the receipt view for a payment payload. `chainCheck` is the local on-chain re-check
 *  outcome and defaults to "unverified", so a receipt is treated as the sender's claim until
 *  a real re-check proves it. Tolerant of a malformed payload: a bad amount shows "0" and an
 *  unknown status reads as proposed rather than throwing. */
export function paymentView(payload: PaymentPayload, chainCheck: ChainCheck = "unverified"): PaymentView {
  const status = statusView(payload.status, chainCheck);
  const signature = payload.signature;
  const known = isKnownCluster(payload.cluster);
  // Normalize the cluster before it reaches the explorer link so a hostile value cannot steer
  // the deep link. An unknown cluster falls back to devnet.
  const explorerCluster: ExplorerCluster = known ? (payload.cluster as ExplorerCluster) : "devnet";
  const impliesSettlement = payload.status === "confirmed" || !!signature;
  const baseNetwork = clusterLabel(payload.cluster);
  // The network chip and the settlement honesty line are gated on the SAME on-chain re-check
  // as the settled pill (status.confirmed). A peer-set cluster can never on its own make the
  // card read as a confident network or assert a real on-chain transfer.
  const networkChip = !known
    ? "unknown network"
    : status.confirmed
      ? baseNetwork
      : `unverified · ${baseNetwork}`;
  return {
    amountDisplay: formatBaseUnits(String(payload.amount ?? "0"), payload.decimals ?? 0),
    asset: payload.asset || "token",
    networkLabel: baseNetwork,
    networkChip,
    from: payload.from ?? "",
    to: payload.to ?? "",
    fromShort: shortMiddle(payload.from ?? ""),
    toShort: shortMiddle(payload.to ?? ""),
    memo: payload.memo,
    signature,
    explorerUrl: signature ? explorerTxUrl(signature, explorerCluster) : undefined,
    statusLabel: status.label,
    statusTone: status.tone,
    claimedStatus: payload.status,
    confirmed: status.confirmed,
    claimDisclaimer: !status.confirmed && impliesSettlement ? PAYMENT_CLAIM_DISCLAIMER : undefined,
    honesty: honestyLine(payload.cluster, known, status.confirmed),
  };
}

export interface ToolView {
  name: string;
  /** Pretty-printed arguments for a tool_call, undefined for a tool_result. */
  argsText?: string;
  /** Flattened textual result for a tool_result, undefined for a tool_call. */
  resultText?: string;
  isError: boolean;
  /** Shown on every tool card: these figures are the agent's claim, not a signed receipt. */
  disclaimer: string;
  /** One plain line for the collapsed card, e.g. `symbol: SOL` or `ok · usdcPrice: 121.6`. */
  summary: string;
}

const TOOL_DISCLAIMER = "Agent-reported. Not a signed on-chain receipt.";

/** Render-side ceiling on any tool text a card holds. A hostile tool_call whose arguments or
 *  result is multi-megabyte must not reach the view as one giant string, so it is clipped
 *  here before it becomes a view-model field. */
export const MAX_TOOL_TEXT_CHARS = 4000;

function clipText(s: string): string {
  return s.length > MAX_TOOL_TEXT_CHARS ? `${s.slice(0, MAX_TOOL_TEXT_CHARS)}…` : s;
}

function safeStringify(value: unknown): string {
  try {
    return clipText(JSON.stringify(value, null, 2) ?? String(value));
  } catch {
    return clipText(String(value));
  }
}

/** A one-line digest of a JSON object: up to three scalar fields, ok/error first. */
export function summarize(text: string): string {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return text.replace(/\s+/g, " ").trim().slice(0, 90);
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return String(obj).slice(0, 90);
  const rec = obj as Record<string, unknown>;
  const parts: string[] = [];
  if (rec.ok === false) parts.push(`error: ${String(rec.error ?? "failed")}`);
  for (const [k, v] of Object.entries(rec)) {
    if (parts.length >= 3) break;
    if (k === "ok" || k === "error" || k === "explorer") continue;
    if (v === null || typeof v === "object") continue;
    const sv = typeof v === "number" && !Number.isInteger(v) ? String(Number(v.toPrecision(6))) : String(v);
    parts.push(`${k}: ${sv.length > 14 ? `${sv.slice(0, 6)}…${sv.slice(-4)}` : sv}`);
  }
  return parts.join(" · ");
}

export function toolCallView(payload: ToolCallPayload): ToolView {
  const args = payload.arguments ?? {};
  const hasArgs = args && Object.keys(args).length > 0;
  return {
    name: payload.name || "tool",
    argsText: hasArgs ? safeStringify(args) : undefined,
    isError: false,
    disclaimer: TOOL_DISCLAIMER,
    summary: hasArgs ? summarize(JSON.stringify(args)) : "",
  };
}

function flattenContent(content: ContentPart[] | undefined): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text") parts.push(part.text);
    else if (part.type === "resource_link") parts.push(part.uri);
    else if (part.type === "resource") parts.push(part.resource?.text ?? part.resource?.uri ?? `[${part.type}]`);
    else parts.push(`[${part.type}]`);
  }
  return parts.join("\n");
}

export function toolResultView(payload: ToolResultPayload): ToolView {
  const raw = flattenContent(payload.content);
  // Tools return JSON; indent it so a result card reads as fields, not one long line.
  let text = raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") text = JSON.stringify(parsed, null, 2);
  } catch {
    // Not JSON: show as-is.
  }
  return {
    name: "result",
    resultText: clipText(text) || (payload.isError ? "tool error" : "tool result"),
    isError: !!payload.isError,
    disclaimer: TOOL_DISCLAIMER,
    summary: text ? summarize(raw) : "",
  };
}

/** The sensible default recipient for a new in-thread payment: the counterparty of the most
 *  recent payment in the room (the party that is not us). Returns "" when the room has no
 *  payment to learn a peer from, so the field just starts empty. Pure, so it is testable. */
export function lastPaymentCounterparty(nodes: BondNode[], selfAddress: string | null): string {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (!n || n.type !== "payment" || !n.payload) continue;
    const p = n.payload as PaymentPayload;
    if (selfAddress && p.from === selfAddress) return p.to || "";
    if (selfAddress && p.to === selfAddress) return p.from || "";
    return p.to || p.from || "";
  }
  return "";
}
