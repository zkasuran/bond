import { memo, useEffect, useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
  ZoomIn,
  ReduceMotion,
} from "react-native-reanimated";
import type { BondNode, Identity } from "@/model/node";
import { isType } from "@/model/messages";
import type { RenderRow } from "@/model/thread";
import { verifyNode } from "@/identity/sign";
import { useTokens } from "@/theme";
import { spring } from "@/theme/motion";
import { Avatar } from "@/components/ui/Avatar";
import { VerifiedBadge } from "@/components/ui/Badge";
import { Txt } from "@/components/ui/Text";
import { TypingDots } from "@/components/motion/Ambient";
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

/** The streaming caret: a soft blink at the end of an agent's growing reply. */
function Caret() {
  const { c } = useTokens();
  const reduced = useReducedMotion();
  const o = useSharedValue(1);
  useEffect(() => {
    if (reduced) return;
    o.set(withRepeat(withSequence(withTiming(0.15, { duration: 420 }), withTiming(1, { duration: 420 })), -1));
  }, [reduced, o]);
  const style = useAnimatedStyle(() => ({ opacity: o.get() }));
  return <Animated.Text style={[{ color: c.brand, fontSize: 16 }, style]}> ▍</Animated.Text>;
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
      {/* depth rails: the thread's tree, drawn quietly */}
      <View style={{ flexDirection: "row", width: indent }}>
        {Array.from({ length: row.depth }).map((_, i) => (
          <View key={i} style={{ width: 16, alignItems: "center" }}>
            <View
              style={{
                width: 1.5,
                flex: 1,
                backgroundColor: i === row.depth - 1 ? (isAgent ? c.agent + "55" : c.brand + "44") : c.border,
                borderRadius: 1,
              }}
            />
          </View>
        ))}
      </View>

      <View style={{ paddingLeft: space[3], paddingTop: 2 }}>
        <Avatar did={author.did} name={author.displayName} kind={author.kind} size={isTool ? 28 : 34} />
      </View>

      <View style={{ flex: 1, paddingLeft: space[3], gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space[2] }}>
          <Txt variant="callout" color={isAgent ? c.agent : c.text}>
            {author.displayName}
          </Txt>
          {isAgent ? (
            <View style={{ backgroundColor: c.agentSoft, borderRadius: radius.sm, paddingHorizontal: 5, paddingVertical: 1 }}>
              <Txt variant="caption" color={c.agent} style={{ fontSize: 10, lineHeight: 13, letterSpacing: 0.6, fontWeight: "600" }}>
                AGENT
              </Txt>
            </View>
          ) : null}
          <VerifiedBadge state={verify} />
          <Txt variant="caption" faint style={{ fontSize: 12 }}>{timeOf(node?.createdAt)}</Txt>
        </View>

        {isPayment ? (
          <PaymentReceipt node={node} />
        ) : isTool ? (
          <ToolCard node={node} />
        ) : streaming && bodyText(node).length === 0 ? (
          <View style={{ paddingVertical: 4 }}>
            <TypingDots />
          </View>
        ) : (
          <View style={{ gap: 2 }}>
            {parseMarkdownLite(bodyText(node)).map((line, i, all) => (
              <View key={i} style={{ flexDirection: "row" }}>
                {line.bullet ? <Txt variant="body" color={isAgent ? c.agent : c.brand} style={{ width: 16 }}>•</Txt> : null}
                <Txt variant="body" style={{ flex: 1 }}>
                  {line.spans.map((s, j) =>
                    s.code ? (
                      <Txt key={j} variant="mono" color={c.textMuted} style={{ fontSize: 14 }}>{s.text}</Txt>
                    ) : (
                      <Txt key={j} variant="body" style={s.bold ? { fontWeight: "700" } : undefined}>{s.text}</Txt>
                    ),
                  )}
                  {streaming && i === all.length - 1 ? <Caret /> : null}
                </Txt>
              </View>
            ))}
          </View>
        )}

        <View style={{ flexDirection: "row", alignItems: "center", gap: space[4], marginTop: 2 }}>
          <Pressable
            onPress={() => onReply(node)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Reply to ${author.displayName}`}
            style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 4, opacity: pressed ? 0.6 : 1 })}
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
      <Txt variant="mono" muted numberOfLines={1} style={{ maxWidth: "70%", fontSize: 12 }}>
        {value || "unknown"}
      </Txt>
    </View>
  );
}

/** The dedicated receipt card for a payment node. Amount hero, asset and network chips, the
 *  parties, a status pill and an explorer deep link once a signature exists. The settled,
 *  green affordance appears only after a local on-chain re-check: a payment node is author
 *  signed but not chain verified, so paymentView defaults to an unverified claim. */
function PaymentReceipt({ node }: { node: BondNode }) {
  const { c, space, radius } = useTokens();
  if (!isType(node, "payment") || !node.payload) {
    return <Txt variant="body" muted>[payment]</Txt>;
  }
  // No local chain re-check is wired through this renderer, so the receipt is shown as the
  // sender's claim. Confirmed/settled is driven by paymentView.confirmed, never by the
  // attacker-set status field, so a peer cannot paint their node as an on-chain settlement.
  const v = paymentView(node.payload);
  const status = toneColors(v.statusTone, c);
  const settled = v.confirmed;
  const openExplorer = () => {
    if (v.explorerUrl) void Linking.openURL(v.explorerUrl).catch(() => {});
  };
  return (
    <View
      style={{
        backgroundColor: c.surface,
        borderWidth: 1,
        borderColor: settled ? c.brand + "55" : c.border,
        borderRadius: radius.lg,
        overflow: "hidden",
        marginTop: 2,
        boxShadow: settled ? `0px 14px 34px -18px ${c.glowBrand}` : undefined,
      }}
    >
      <View style={{ height: 3, backgroundColor: settled ? c.brand : status.fg, opacity: settled ? 1 : 0.5 }} />
      <View style={{ padding: space[3] + 2, gap: space[2] }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space[1] + 2 }}>
            <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: c.brandSoft, alignItems: "center", justifyContent: "center" }}>
              <Ionicons name="arrow-up" size={13} color={c.brand} />
            </View>
            <Txt variant="label" faint>
              Payment
            </Txt>
          </View>
          <StatusPill label={v.statusLabel} fg={status.fg} bg={status.bg} pop={settled} />
        </View>

        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space[2], flexWrap: "wrap" }}>
          <Txt variant="display" style={{ fontSize: 32, lineHeight: 36, letterSpacing: -1.2 }}>{v.amountDisplay}</Txt>
          <Txt variant="callout" muted style={{ marginBottom: 4 }}>{v.asset}</Txt>
          <View
            style={{
              backgroundColor: settled ? c.brandSoft : c.surfaceAlt,
              paddingHorizontal: space[2],
              paddingVertical: 2,
              borderRadius: radius.pill,
              marginBottom: 5,
            }}
          >
            <Txt variant="caption" color={settled ? c.brand : c.textMuted} style={{ fontSize: 12, lineHeight: 16 }}>{v.networkChip}</Txt>
          </View>
        </View>

        <View style={{ gap: 3, paddingTop: space[1], borderTopWidth: 1, borderTopColor: c.border }}>
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
              {settled
                ? `View on Solana Explorer (${v.networkLabel})`
                : `Check the sender's signature on Solana Explorer (${v.networkLabel})`}
            </Txt>
          </Pressable>
        ) : null}

        {v.claimDisclaimer ? (
          <Txt variant="caption" faint style={{ fontSize: 11, lineHeight: 14 }}>{v.claimDisclaimer}</Txt>
        ) : null}
        <Txt variant="caption" faint style={{ fontSize: 12 }}>{v.honesty}</Txt>
      </View>
    </View>
  );
}

function StatusPill({ label, fg, bg, pop }: { label: string; fg: string; bg: string; pop: boolean }) {
  const { space, radius } = useTokens();
  return (
    <Animated.View
      entering={pop ? ZoomIn.springify().damping(spring.bouncy.damping).stiffness(spring.bouncy.stiffness).reduceMotion(ReduceMotion.System) : undefined}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        backgroundColor: bg,
        paddingHorizontal: space[2],
        paddingVertical: 2,
        borderRadius: radius.pill,
      }}
    >
      {pop ? <Ionicons name="checkmark-circle" size={12} color={fg} /> : <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: fg }} />}
      <Txt variant="caption" color={fg} style={{ fontSize: 12, lineHeight: 16 }}>{label}</Txt>
    </Animated.View>
  );
}

/** A tool_call or tool_result rendered as a labeled card. Every tool card carries the
 *  agent-reported disclaimer so an agent's claimed balance or signature is never read as a
 *  signed on-chain receipt. The payment card is only the sender's claim too until its
 *  signature is re-checked on-chain (see paymentView). Neither card implies settlement on
 *  its own. */
function ToolCard({ node }: { node: BondNode }) {
  const { c, space, radius } = useTokens();
  const [open, setOpen] = useState(false);
  const turn = useSharedValue(0);
  const call = isType(node, "tool_call") && node.payload ? toolCallView(node.payload) : null;
  const result = isType(node, "tool_result") && node.payload ? toolResultView(node.payload) : null;
  const chevron = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.get() * 180}deg` }] }));
  const view = call ?? result;
  if (!view) return <Txt variant="body" muted>[{node.type}]</Txt>;
  const accent = view.isError ? c.tampered : call ? c.agent : c.verified;
  const body = view.argsText ?? view.resultText ?? "";
  const toggle = () => {
    if (!body) return;
    turn.set(withSpring(open ? 0 : 1, spring.snappy));
    setOpen((o) => !o);
  };
  // Collapsed by default: a tool step is supporting evidence for the reply, so it shows
  // one line and expands to the full JSON on demand instead of crowding the thread.
  return (
    <Pressable
      onPress={toggle}
      accessibilityRole="button"
      accessibilityLabel={`${call ? "Tool call" : "Tool result"} ${view.name}, ${open ? "hide" : "show"} details`}
      style={({ pressed }) => ({
        backgroundColor: c.surfaceAlt,
        borderWidth: 1,
        borderColor: c.border,
        borderLeftWidth: 3,
        borderLeftColor: accent,
        borderRadius: radius.md,
        paddingHorizontal: space[3],
        paddingVertical: space[2] + 2,
        gap: space[1],
        marginTop: 2,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[1] + 2 }}>
        <Ionicons
          name={call ? "flash-outline" : view.isError ? "alert-circle-outline" : "checkmark-circle-outline"}
          size={14}
          color={accent}
        />
        <Txt variant="caption" color={accent} style={{ fontWeight: "600" }}>
          {call ? "called" : view.isError ? "tool error" : "returned"}
        </Txt>
        {call ? (
          <Txt variant="mono" color={c.text} numberOfLines={1} style={{ flexShrink: 1, fontSize: 12 }}>
            {view.name}
          </Txt>
        ) : null}
        <View style={{ flex: 1 }} />
        {body ? (
          <Animated.View style={chevron}>
            <Ionicons name="chevron-down" size={14} color={c.textFaint} />
          </Animated.View>
        ) : null}
      </View>
      {open ? (
        <Txt variant="mono" muted style={{ fontSize: 12 }}>{body}</Txt>
      ) : view.summary ? (
        <Txt variant="mono" muted numberOfLines={1} style={{ fontSize: 12 }}>{view.summary}</Txt>
      ) : null}
      <Txt variant="caption" faint style={{ fontSize: 11, lineHeight: 14 }}>{view.disclaimer}</Txt>
    </Pressable>
  );
}
