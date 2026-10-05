import { useEffect, useState } from "react";
import { Platform, Pressable, TextInput, View, ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Animated, {
  FadeInDown,
  FadeOutDown,
  ReduceMotion,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import type { BondNode } from "@/model/node";
import type { Membership } from "@/rooms/roles";
import { useTokens } from "@/theme";
import { spring } from "@/theme/motion";
import { Txt } from "@/components/ui/Text";
import { PressableScale } from "@/components/motion/PressableScale";

/** The send button wakes up when there is something to send: it grows, turns mint and the
 *  arrow lifts. Empty, it rests small and quiet. */
function SendButton({ active, onPress }: { active: boolean; onPress: () => void }) {
  const { c } = useTokens();
  const t = useSharedValue(active ? 1 : 0);
  useEffect(() => {
    t.set(withSpring(active ? 1 : 0, spring.bouncy));
  }, [active, t]);
  const shell = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(t.get(), [0, 1], [c.surfaceSunken, c.brand]),
    transform: [{ scale: 0.88 + t.get() * 0.12 }],
  }));
  const arrow = useAnimatedStyle(() => ({ opacity: 0.55 + t.get() * 0.45, transform: [{ translateY: (1 - t.get()) * 3 }] }));
  return (
    <PressableScale
      testID="composer-send"
      onPress={onPress}
      disabled={!active}
      accessibilityRole="button"
      accessibilityLabel="Send message"
      pressedScale={0.88}
    >
      <Animated.View style={[{ width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" }, shell]}>
        <Animated.View style={arrow}>
          <Ionicons name="arrow-up" size={21} color={active ? c.onBrand : c.textFaint} />
        </Animated.View>
      </Animated.View>
    </PressableScale>
  );
}

export function Composer({
  agents,
  replyingTo,
  onCancelReply,
  onSend,
  onRequestPay,
}: {
  agents: Membership[];
  replyingTo: BondNode | null;
  onCancelReply: () => void;
  onSend: (body: string, mentions: string[]) => void;
  /** Open the in-thread USDC pay sheet. Omitted on surfaces that cannot pay. */
  onRequestPay?: () => void;
}) {
  const { c, space, radius } = useTokens();
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const [focused, setFocused] = useState(false);

  const toggle = (did: string) =>
    setMentions((m) => (m.includes(did) ? m.filter((x) => x !== did) : [...m, did]));

  const send = () => {
    const body = text.trim();
    if (!body) return;
    onSend(body, mentions);
    setText("");
    setMentions([]);
  };

  const hasText = text.trim().length > 0;

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
        <Animated.View
          entering={FadeInDown.duration(180).reduceMotion(ReduceMotion.System)}
          exiting={FadeOutDown.duration(140).reduceMotion(ReduceMotion.System)}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space[2],
            backgroundColor: c.surfaceAlt,
            borderRadius: radius.md,
            borderLeftWidth: 3,
            borderLeftColor: c.brand,
            paddingHorizontal: space[3],
            paddingVertical: space[2],
          }}
        >
          <Ionicons name="return-down-forward" size={14} color={c.brand} />
          <Txt variant="caption" muted style={{ flex: 1 }} numberOfLines={1}>
            Replying to {replyingTo.author.displayName}
          </Txt>
          <Pressable onPress={onCancelReply} hitSlop={8} accessibilityRole="button" accessibilityLabel="Cancel reply">
            <Ionicons name="close" size={16} color={c.textFaint} />
          </Pressable>
        </Animated.View>
      ) : null}

      {agents.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space[2] }} keyboardShouldPersistTaps="handled">
          {agents.map((a) => {
            const on = mentions.includes(a.did);
            return (
              <PressableScale
                key={a.did}
                onPress={() => toggle(a.did)}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`Mention ${a.displayName}`}
                pressedScale={0.92}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 4,
                  backgroundColor: on ? c.agent : c.agentSoft,
                  borderWidth: 1,
                  borderColor: on ? c.agent : c.agent + "33",
                  paddingHorizontal: space[3],
                  paddingVertical: 6,
                  borderRadius: radius.pill,
                }}
              >
                <Ionicons name={on ? "sparkles" : "at"} size={13} color={on ? c.onBrand : c.agent} />
                <Txt variant="caption" color={on ? c.onBrand : c.agent} style={{ fontWeight: "600" }}>
                  {a.displayName}
                </Txt>
              </PressableScale>
            );
          })}
        </ScrollView>
      ) : null}

      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space[2] }}>
        {onRequestPay ? (
          <PressableScale
            testID="composer-pay"
            onPress={onRequestPay}
            accessibilityRole="button"
            accessibilityLabel="Send USDC"
            pressedScale={0.88}
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: c.brandSoft,
              borderWidth: 1,
              borderColor: c.brand + "40",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ionicons name="logo-usd" size={19} color={c.brand} />
          </PressableScale>
        ) : null}
        <TextInput
          value={text}
          onChangeText={setText}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={mentions.length ? "Message your agent…" : "Message"}
          placeholderTextColor={c.textFaint}
          multiline
          // react-native-web renders a two-row textarea by default; one row matches native.
          numberOfLines={Platform.OS === "web" ? 1 : undefined}
          style={{
            flex: 1,
            maxHeight: 120,
            minHeight: 44,
            color: c.text,
            backgroundColor: c.surfaceAlt,
            borderWidth: 1,
            borderColor: focused ? c.brand + "66" : c.border,
            borderRadius: 22,
            paddingHorizontal: space[4],
            paddingTop: 11,
            paddingBottom: 11,
            fontSize: 16,
            // The focus state is the mint border; drop the browser's own ring on web.
            outlineWidth: 0,
          }}
        />
        <SendButton active={hasText} onPress={send} />
      </View>
    </View>
  );
}
