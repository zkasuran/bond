import { useEffect, useMemo, useRef, useState } from "react";
import { Keyboard, KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import Animated from "react-native-reanimated";
import type { BondNode } from "@/model/node";
import { buildForest, flattenForRender } from "@/model/thread";
import { useBond } from "@/state/store";
import { useWallet } from "@/solana/store";
import { useTokens } from "@/theme";
import { enter } from "@/theme/motion";
import { Screen } from "@/components/ui/Screen";
import { Txt } from "@/components/ui/Text";
import { Avatar } from "@/components/ui/Avatar";
import { PresenceDot } from "@/components/ui/PresenceDot";
import { MessageNode } from "@/components/thread/MessageNode";
import { Composer } from "@/components/thread/Composer";
import { PaySheet } from "@/components/thread/PaySheet";
import { lastPaymentCounterparty } from "@/components/thread/receipt";
import { BondMark } from "@/components/motion/BondMark";
import { PressableScale } from "@/components/motion/PressableScale";
import { useAndroidKeyboardInset } from "@/hooks/use-keyboard-inset";

const EMPTY: never[] = [];

/** Starter prompts for an empty room. Each one mentions the agent, so it runs a real turn. */
const STARTERS = ["What is my USDC balance on devnet?", "Quote 1 SOL to USDC on Jupiter", "What skills can you run?"];

export default function RoomScreen() {
  const keyboardInset = useAndroidKeyboardInset();
  const { c, space, radius } = useTokens();
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  const rid = roomId ?? "";
  const router = useRouter();

  const room = useBond((s) => s.rooms.find((r) => r.id === rid));
  const nodes = useBond((s) => s.nodes[rid]) ?? EMPTY;
  const members = useBond((s) => s.members[rid]) ?? EMPTY;
  const streaming = useBond((s) => s.streaming);
  const walletAddress = useWallet((s) => s.connectedAddress);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [replyTo, setReplyTo] = useState<BondNode | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  // Nodes already in the room when it opened render in place; only new ones animate in,
  // so opening a long thread is instant and a fresh message still lands with life.
  const [initialIds] = useState(() => new Set(nodes.map((n) => n.id)));

  // Connect this room's live /sync socket while the screen is open so humans and agents on
  // other devices appear as peers here, then close it on unmount. The store guards platform
  // specifics (no WebSocket means no socket), so this is additive and safe with sync off.
  useEffect(() => {
    if (!rid) return;
    const bond = useBond.getState();
    void bond.openRoomSync(rid);
    return () => bond.closeRoomSync(rid);
  }, [rid]);

  const forest = useMemo(() => buildForest(nodes), [nodes]);
  const rows = useMemo(() => flattenForRender(forest, collapsed), [forest, collapsed]);
  const agents = members.filter((m) => m.kind === "agent");
  const humans = members.length - agents.length;
  const agentBusy = Object.keys(streaming).some((id) => streaming[id] && nodes.some((n) => n.id === id));
  const defaultRecipient = useMemo(
    () => lastPaymentCounterparty(nodes, walletAddress),
    [nodes, walletAddress],
  );

  const send = (body: string, mentions: string[]) => {
    const parentId = replyTo?.id ?? null;
    setReplyTo(null);
    void useBond.getState().postText(rid, parentId, body, mentions);
  };

  const sendPayment = async (toAddress: string, uiAmount: string, memo?: string) => {
    const parentId = replyTo?.id ?? null;
    await useBond.getState().sendPayment(rid, parentId, toAddress, uiAmount, memo);
    setReplyTo(null);
  };

  const toggleCollapse = (id: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const iconButton = { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center", backgroundColor: c.surfaceAlt } as const;

  return (
    <Screen edges={["top", "bottom"]}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space[3],
          paddingHorizontal: space[3],
          paddingTop: space[1],
          paddingBottom: space[3],
          borderBottomWidth: 1,
          borderBottomColor: c.border,
          backgroundColor: c.bg,
        }}
      >
        <PressableScale onPress={() => router.back()} hitSlop={10} accessibilityRole="button" accessibilityLabel="Back" style={iconButton}>
          <Ionicons name="chevron-back" size={22} color={c.text} />
        </PressableScale>
        <View style={{ flex: 1 }}>
          <Txt variant="heading" numberOfLines={1}>{room?.title ?? "Room"}</Txt>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            {agents.length > 0 ? <PresenceDot color={agentBusy ? c.agent : c.online} size={6} live busy={agentBusy} /> : null}
            <Txt variant="caption" faint>
              {agentBusy
                ? "Bond is working…"
                : `${humans} ${humans === 1 ? "human" : "humans"} · ${agents.length} ${agents.length === 1 ? "agent" : "agents"}`}
            </Txt>
          </View>
        </View>
        <View style={{ flexDirection: "row" }}>
          {members.slice(0, 3).map((m, i) => (
            <View key={m.did} style={{ marginLeft: i === 0 ? 0 : -9 }}>
              <Avatar did={m.did} name={m.displayName} kind={m.kind} size={26} ring={c.bg} />
            </View>
          ))}
        </View>
        <PressableScale
          onPress={() => router.push({ pathname: "/room/[roomId]/settings", params: { roomId: rid } })}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Room settings"
          style={iconButton}
        >
          <Ionicons name="options-outline" size={19} color={c.textMuted} />
        </PressableScale>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1, paddingBottom: keyboardInset }}
        // iOS only: Android is edge-to-edge, where this under-measures, so Android pads
        // by the measured keyboard height instead (useAndroidKeyboardInset).
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        enabled={Platform.OS === "ios"}
        keyboardVerticalOffset={Platform.OS === "ios" ? 8 : 0}
      >
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={{ paddingVertical: space[3], flexGrow: 1 }}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
          keyboardShouldPersistTaps="handled"
        >
          {rows.length === 0 ? (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space[6], gap: space[4] }}>
              <Animated.View entering={enter.fade(80)} style={{ height: 104, justifyContent: "center" }}>
                <BondMark size={42} animate rings breathe delay={200} />
              </Animated.View>
              <Animated.View entering={enter.hero(2)} style={{ alignItems: "center", gap: space[2] }}>
                <Txt variant="title" style={{ textAlign: "center" }}>Say hi to Bond</Txt>
                <Txt variant="body" muted style={{ textAlign: "center", maxWidth: 300 }}>
                  Tap the @Bond chip below, then send a message. Bond replies right inside the thread.
                </Txt>
              </Animated.View>
              {agents[0] ? (
                <View style={{ gap: space[2], alignSelf: "stretch", marginTop: space[2] }}>
                  {STARTERS.map((s, i) => (
                    <Animated.View key={s} entering={enter.row(i + 3)}>
                      <PressableScale
                        onPress={() => send(s, [agents[0]!.did])}
                        accessibilityRole="button"
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: space[2],
                          paddingVertical: space[3],
                          paddingHorizontal: space[4],
                          borderRadius: radius.lg,
                          borderWidth: 1,
                          borderColor: c.border,
                          backgroundColor: c.surface,
                        }}
                      >
                        <Ionicons name="sparkles-outline" size={15} color={c.agent} />
                        <Txt variant="callout" style={{ flex: 1, fontWeight: "500" }}>{s}</Txt>
                        <Ionicons name="arrow-forward" size={15} color={c.textFaint} />
                      </PressableScale>
                    </Animated.View>
                  ))}
                </View>
              ) : null}
            </View>
          ) : (
            rows.map((row) => (
              <Animated.View key={row.node.id} entering={initialIds.has(row.node.id) ? undefined : enter.message()}>
                <MessageNode
                  row={row}
                  streaming={!!streaming[row.node.id]}
                  onReply={setReplyTo}
                  onToggleCollapse={toggleCollapse}
                />
              </Animated.View>
            ))
          )}
        </ScrollView>

        <Composer
          agents={agents}
          replyingTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          onSend={send}
          onRequestPay={() => {
            // Close the message keyboard first, so it does not come back over the receipt
            // card when the pay sheet closes.
            Keyboard.dismiss();
            setPayOpen(true);
          }}
        />
      </KeyboardAvoidingView>

      <PaySheet
        key={payOpen ? "pay-open" : "pay-closed"}
        visible={payOpen}
        defaultRecipient={defaultRecipient}
        selfAddress={walletAddress}
        onSubmit={sendPayment}
        onClose={() => setPayOpen(false)}
      />
    </Screen>
  );
}
