import { memo } from "react";
import { Linking, Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { BondNode, Identity } from "@/model/node";
import { isType } from "@/model/messages";
import type { RenderRow } from "@/model/thread";
import { verifyNode } from "@/identity/sign";
import { useTokens } from "@/theme";
import { Avatar } from "@/components/ui/Avatar";
import { VerifiedBadge } from "@/components/ui/Badge";
import { Txt } from "@/components/ui/Text";
import { parseMarkdownLite } from "./markdown";
import {
  paymentView,
  toolCallView,
  toolResultView,
  type ReceiptTone,
} from "./receipt";

const UNKNOWN_AUTHOR: Identity = { did: "", displayName: "Unknown", kind: "human" };

function timeOf(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

/** Text for the node types that render as a plain line. Payment and tool nodes have their
 *  own cards below, so they never reach this. */
function bodyText(node: BondNode): string {
  if (isType(node, "text")) return node.payload?.body ?? "";
  if (isType(node, "status")) return node.payload?.note ?? `[${node.payload?.lifecycle ?? "status"}]`;
  return `[${node.type}]`;
}

export const MessageNode = memo(function MessageNode({
  row,
  streaming,
  onReply,
  onToggleCollapse,
}: {
  row: RenderRow;
  streaming: boolean;
  onReply: (node: BondNode) => void;
  onToggleCollapse: (nodeId: string) => void;
}) {
  const { c, space, radius } = useTokens();
  const node = row.node;
  // Guard every author read: a malformed or partial node must render, never throw.
  const author = node?.author ?? UNKNOWN_AUTHOR;
  const isAgent = author.kind === "agent";
  const verify = verifyNode(node);
  const indent = row.depth * 16;

  const isPayment = node?.type === "payment";
  const isTool = node?.type === "tool_call" || node?.type === "tool_result";

  return (
    <View style={{ flexDirection: "row", paddingRight: space[4], paddingVertical: space[2] }}>
      {/* depth rails */}
      <View style={{ flexDirection: "row", width: indent }}>
        {Array.from({ length: row.depth }).map((_, i) => (
          <View key={i} style={{ width: 16, alignItems: "center" }}>
            <View style={{ width: 1.5, flex: 1, backgroundColor: c.border, borderRadius: 1 }} />
          </View>
        ))}
      </View>

      <View style={{ paddingLeft: space[3] }}>
        <Avatar did={author.did} name={author.displayName} kind={author.kind} size={34} />
      </View>

      <View style={{ flex: 1, paddingLeft: space[3], gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space[2] }}>
          <Txt variant="callout" color={isAgent ? c.agent : c.text}>
            {author.displayName}
          </Txt>
          {isAgent ? <Txt variant="caption" faint>agent</Txt> : null}
          <VerifiedBadge state={verify} />
          <Txt variant="caption" faint>{timeOf(node?.createdAt)}</Txt>
        </View>

        {isPayment ? (
          <PaymentReceipt node={node} />
        ) : isTool ? (
          <ToolCard node={node} />
        ) : streaming && bodyText(node).length === 0 ? (
          <Txt variant="body" muted>thinking…</Txt>
        ) : (
          <View style={{ gap: 2 }}>
            {parseMarkdownLite(bodyText(node)).map((line, i, all) => (
              <View key={i} style={{ flexDirection: "row" }}>
                {line.bullet ? <Txt variant="body" style={{ width: 16 }}>•</Txt> : null}
                <Txt variant="body" style={{ flex: 1 }}>
                  {line.spans.map((s, j) =>
                    s.code ? (
                      <Txt key={j} variant="mono" style={{ fontSize: 14 }}>{s.text}</Txt>
                    ) : (
                      <Txt key={j} variant="body" style={s.bold ? { fontWeight: "700" } : undefined}>{s.text}</Txt>
                    ),
                  )}
                  {streaming && i === all.length - 1 ? <Txt variant="body" color={c.brand}> ▍</Txt> : null}
                </Txt>
              </View>
            ))}
          </View>
        )}

        <View style={{ flexDirection: "row", alignItems: "center", gap: space[4], marginTop: 2 }}>
          <Pressable
            onPress={() => onReply(node)}
            hitSlop={8}
            style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
          >
            <Ionicons name="return-down-forward" size={13} color={c.textFaint} />
            <Txt variant="caption" faint>Reply</Txt>
          </Pressable>
          {row.hiddenCount > 0 ? (
            <Pressable
              onPress={() => onToggleCollapse(node.id)}
              hitSlop={8}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                backgroundColor: c.brandSoft,
                paddingHorizontal: space[2],
                paddingVertical: 2,
                borderRadius: radius.pill,
              }}
            >
              <Ionicons name="chevron-down" size={13} color={c.brand} />
              <Txt variant="caption" color={c.brand}>
                {row.hiddenCount} {row.hiddenCount === 1 ? "reply" : "replies"}
              </Txt>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
});

function toneColors(
  tone: ReceiptTone,
  c: ReturnType<typeof useTokens>["c"],
): { fg: string; bg: string } {
  if (tone === "verified") return { fg: c.verified, bg: c.verifiedSoft };
  if (tone === "tampered") return { fg: c.tampered, bg: c.tamperedSoft };
  if (tone === "warning") return { fg: c.warning, bg: c.surfaceAlt };
  return { fg: c.textMuted, bg: c.surfaceAlt };
}

function PartyRow({ label, value }: { label: string; value: string }) {
  const { space } = useTokens();
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space[2] }}>
      <Txt variant="caption" faint>{label}</Txt>
      <Txt variant="mono" muted numberOfLines={1} style={{ maxWidth: "70%" }}>
        {value || "unknown"}
      </Txt>
    </View>
  );
}

/** The dedicated receipt card for a payment node. Amount hero, asset and network chips, the
 *  parties, a status pill and an explorer deep link once a signature exists. */
function PaymentReceipt({ node }: { node: BondNode }) {
  const { c, space, radius } = useTokens();
  if (!isType(node, "payment") || !node.payload) {
    return <Txt variant="body" muted>[payment]</Txt>;
  }
  const v = paymentView(node.payload);
  const status = toneColors(v.statusTone, c);
  const openExplorer = () => {
    if (v.explorerUrl) void Linking.openURL(v.explorerUrl).catch(() => {});
  };
  return (
    <View
      style={{
        backgroundColor: c.surface,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: radius.lg,
        padding: space[3],
        gap: space[2],
        marginTop: 2,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[1] }}>
          <Ionicons name="arrow-up-circle" size={16} color={c.brand} />
          <Txt variant="caption" faint style={{ letterSpacing: 0.5, textTransform: "uppercase" }}>
            Payment
          </Txt>
        </View>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            backgroundColor: status.bg,
            paddingHorizontal: space[2],
            paddingVertical: 2,
            borderRadius: radius.pill,
          }}
        >
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: status.fg }} />
          <Txt variant="caption" color={status.fg}>{v.statusLabel}</Txt>
        </View>
      </View>

      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space[2], flexWrap: "wrap" }}>
        <Txt variant="display" style={{ fontSize: 26, lineHeight: 30 }}>{v.amountDisplay}</Txt>
        <Txt variant="callout" muted style={{ marginBottom: 3 }}>{v.asset}</Txt>
        <View
          style={{
            backgroundColor: c.brandSoft,
            paddingHorizontal: space[2],
            paddingVertical: 2,
            borderRadius: radius.pill,
            marginBottom: 2,
          }}
        >
          <Txt variant="caption" color={c.brand}>{v.networkLabel}</Txt>
        </View>
      </View>

      <View style={{ gap: 2 }}>
        <PartyRow label="From" value={v.fromShort} />
        <PartyRow label="To" value={v.toShort} />
        {v.memo ? <PartyRow label="Memo" value={v.memo} /> : null}
      </View>

      {v.explorerUrl ? (
        <Pressable
          onPress={openExplorer}
          hitSlop={6}
          accessibilityRole="link"
          style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
        >
          <Ionicons name="open-outline" size={13} color={c.brand} />
          <Txt variant="caption" color={c.brand}>
            View on Solana Explorer ({v.networkLabel})
          </Txt>
        </Pressable>
      ) : null}

      <Txt variant="caption" faint>{v.honesty}</Txt>
    </View>
  );
}

/** A tool_call or tool_result rendered as a labeled card. Every tool card carries the
 *  agent-reported disclaimer so an agent's claimed balance or signature is never read as a
 *  signed on-chain receipt (that is only the payment card above). */
function ToolCard({ node }: { node: BondNode }) {
  const { c, space, radius } = useTokens();
  const call = isType(node, "tool_call") && node.payload ? toolCallView(node.payload) : null;
  const result = isType(node, "tool_result") && node.payload ? toolResultView(node.payload) : null;
  const view = call ?? result;
  if (!view) return <Txt variant="body" muted>[{node.type}]</Txt>;
  const accent = view.isError ? c.tampered : c.agent;
  const body = view.argsText ?? view.resultText ?? "";
  return (
    <View
      style={{
        backgroundColor: c.surfaceAlt,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: radius.md,
        padding: space[3],
        gap: space[2],
        marginTop: 2,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[1] }}>
        <Ionicons name={call ? "construct-outline" : "return-down-forward"} size={14} color={accent} />
        <Txt variant="caption" color={accent}>
          {call ? "called" : view.isError ? "tool error" : "result"}
        </Txt>
        <Txt variant="mono" color={accent} numberOfLines={1} style={{ flexShrink: 1 }}>
          {view.name}
        </Txt>
      </View>
      {body ? (
        <Txt variant="mono" muted numberOfLines={10}>{body}</Txt>
      ) : null}
      <Txt variant="caption" faint>{view.disclaimer}</Txt>
    </View>
  );
}
