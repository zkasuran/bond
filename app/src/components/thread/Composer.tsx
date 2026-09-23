import { useState } from "react";
import { Pressable, TextInput, View, ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { BondNode } from "@/model/node";
import type { Membership } from "@/rooms/roles";
import { useTokens } from "@/theme";
import { Txt } from "@/components/ui/Text";

export function Composer({
  agents,
  replyingTo,
  onCancelReply,
  onSend,
}: {
  agents: Membership[];
  replyingTo: BondNode | null;
  onCancelReply: () => void;
  onSend: (body: string, mentions: string[]) => void;
}) {
  const { c, space, radius } = useTokens();
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);

  const toggle = (did: string) =>
    setMentions((m) => (m.includes(did) ? m.filter((x) => x !== did) : [...m, did]));

  const send = () => {
    const body = text.trim();
    if (!body) return;
    onSend(body, mentions);
    setText("");
    setMentions([]);
  };

  return (
    <View
      style={{
        borderTopWidth: 1,
        borderTopColor: c.border,
        backgroundColor: c.surface,
        paddingHorizontal: space[3],
        paddingTop: space[2],
        paddingBottom: space[3],
        gap: space[2],
      }}
    >
      {replyingTo ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
          <Ionicons name="return-down-forward" size={14} color={c.textFaint} />
          <Txt variant="caption" faint style={{ flex: 1 }} numberOfLines={1}>
            Replying to {replyingTo.author.displayName}
          </Txt>
          <Pressable onPress={onCancelReply} hitSlop={8}>
            <Ionicons name="close" size={16} color={c.textFaint} />
          </Pressable>
        </View>
      ) : null}

      {agents.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space[2] }}>
          {agents.map((a) => {
            const on = mentions.includes(a.did);
            return (
              <Pressable
                key={a.did}
                onPress={() => toggle(a.did)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 4,
                  backgroundColor: on ? c.agent : c.agentSoft,
                  paddingHorizontal: space[3],
                  paddingVertical: 6,
                  borderRadius: radius.pill,
                }}
              >
                <Ionicons name="at" size={13} color={on ? "#fff" : c.agent} />
                <Txt variant="caption" color={on ? "#fff" : c.agent}>
                  {a.displayName}
                </Txt>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space[2] }}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={mentions.length ? "Message your agent…" : "Message"}
          placeholderTextColor={c.textFaint}
          multiline
          style={{
            flex: 1,
            maxHeight: 120,
            minHeight: 42,
            color: c.text,
            backgroundColor: c.surfaceAlt,
            borderRadius: radius.lg,
            paddingHorizontal: space[3],
            paddingTop: 10,
            paddingBottom: 10,
            fontSize: 16,
          }}
        />
        <Pressable
          testID="composer-send"
          onPress={send}
          disabled={!text.trim()}
          style={{
            width: 42,
            height: 42,
            borderRadius: 21,
            backgroundColor: text.trim() ? c.brand : c.surfaceSunken,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Ionicons name="arrow-up" size={20} color={text.trim() ? "#fff" : c.textFaint} />
        </Pressable>
      </View>
    </View>
  );
}
