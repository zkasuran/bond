import { useMemo, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { BondNode } from "@/model/node";
import { buildForest, flattenForRender } from "@/model/thread";
import { useBond } from "@/state/store";
import { useTokens } from "@/theme";
import { Screen } from "@/components/ui/Screen";
import { Txt } from "@/components/ui/Text";
import { Avatar } from "@/components/ui/Avatar";
import { MessageNode } from "@/components/thread/MessageNode";
import { Composer } from "@/components/thread/Composer";

const EMPTY: never[] = [];

export default function RoomScreen() {
  const { c, space } = useTokens();
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  const rid = roomId ?? "";
  const router = useRouter();

  const room = useBond((s) => s.rooms.find((r) => r.id === rid));
  const nodes = useBond((s) => s.nodes[rid]) ?? EMPTY;
  const members = useBond((s) => s.members[rid]) ?? EMPTY;
  const streaming = useBond((s) => s.streaming);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [replyTo, setReplyTo] = useState<BondNode | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const forest = useMemo(() => buildForest(nodes), [nodes]);
  const rows = useMemo(() => flattenForRender(forest, collapsed), [forest, collapsed]);
  const agents = members.filter((m) => m.kind === "agent");

  const send = (body: string, mentions: string[]) => {
    const parentId = replyTo?.id ?? null;
    setReplyTo(null);
    void useBond.getState().postText(rid, parentId, body, mentions);
  };

  const toggleCollapse = (id: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Screen edges={["top", "bottom"]}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space[2],
          paddingHorizontal: space[3],
          paddingBottom: space[2],
          borderBottomWidth: 1,
          borderBottomColor: c.border,
        }}
      >
        <Pressable onPress={() => router.back()} hitSlop={10} style={{ padding: 4 }}>
          <Ionicons name="chevron-back" size={24} color={c.text} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Txt variant="heading" numberOfLines={1}>{room?.title ?? "Room"}</Txt>
          <Txt variant="caption" faint>
            {members.length} {members.length === 1 ? "member" : "members"}
          </Txt>
        </View>
        <View style={{ flexDirection: "row" }}>
          {members.slice(0, 3).map((m, i) => (
            <View key={m.did} style={{ marginLeft: i === 0 ? 0 : -8 }}>
              <Avatar did={m.did} name={m.displayName} kind={m.kind} size={26} />
            </View>
          ))}
        </View>
        <Pressable
          onPress={() => router.push({ pathname: "/room/[roomId]/settings", params: { roomId: rid } })}
          hitSlop={10}
          style={{ padding: 4 }}
        >
          <Ionicons name="settings-outline" size={20} color={c.textMuted} />
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 8 : 0}
      >
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={{ paddingVertical: space[3], flexGrow: 1 }}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        >
          {rows.length === 0 ? (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space[6], gap: space[3] }}>
              <Ionicons name="sparkles-outline" size={34} color={c.agent} />
              <Txt variant="heading" style={{ textAlign: "center" }}>Say hi to Bond</Txt>
              <Txt variant="body" muted style={{ textAlign: "center" }}>
                Tap the @Bond chip below, then send a message. Bond replies right inside the thread.
              </Txt>
            </View>
          ) : (
            rows.map((row) => (
              <MessageNode
                key={row.node.id}
                row={row}
                streaming={!!streaming[row.node.id]}
                onReply={setReplyTo}
                onToggleCollapse={toggleCollapse}
              />
            ))
          )}
        </ScrollView>

        <Composer
          agents={agents}
          replyingTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          onSend={send}
        />
      </KeyboardAvoidingView>
    </Screen>
  );
}
