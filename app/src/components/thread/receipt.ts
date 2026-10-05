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

export interface PaymentView {
  amountDisplay: string;
  asset: string;
  networkLabel: string;
  from: string;
  to: string;
  fromShort: string;
  toShort: string;
  memo?: string;
  signature?: string;
  explorerUrl?: string;
  statusLabel: string;
  statusTone: ReceiptTone;
  /** True only for a settled, on-chain-confirmed transfer. */
  confirmed: boolean;
  honesty: string;
}

const STATUS_META: Record<PaymentPayload["status"], { label: string; tone: ReceiptTone }> = {
  proposed: { label: "Proposed", tone: "muted" },
  pending: { label: "Pending", tone: "warning" },
  confirmed: { label: "Confirmed", tone: "verified" },
  failed: { label: "Failed", tone: "tampered" },
};

function clusterLabel(cluster: PaymentPayload["cluster"]): string {
  return cluster === "mainnet-beta" ? "mainnet" : cluster;
}

/** Build the receipt view for a payment payload. Tolerant of a malformed payload: a bad
 *  amount shows "0" and an unknown status reads as proposed rather than throwing. */
export function paymentView(payload: PaymentPayload): PaymentView {
  const status = STATUS_META[payload.status] ?? STATUS_META.proposed;
  const signature = payload.signature;
  const cluster = payload.cluster as ExplorerCluster;
  return {
    amountDisplay: formatBaseUnits(String(payload.amount ?? "0"), payload.decimals ?? 0),
    asset: payload.asset || "token",
    networkLabel: clusterLabel(payload.cluster),
    from: payload.from ?? "",
    to: payload.to ?? "",
    fromShort: shortMiddle(payload.from ?? ""),
    toShort: shortMiddle(payload.to ?? ""),
    memo: payload.memo,
    signature,
    explorerUrl: signature ? explorerTxUrl(signature, cluster) : undefined,
    statusLabel: status.label,
    statusTone: status.tone,
    confirmed: payload.status === "confirmed",
    honesty:
      payload.cluster === "mainnet-beta"
        ? "On-chain transfer."
        : "Devnet transfer. No real funds.",
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

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
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
    resultText: text || (payload.isError ? "tool error" : "tool result"),
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
