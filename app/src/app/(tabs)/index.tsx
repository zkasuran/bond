import { useEffect, useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import Animated, {
  FadeOutUp,
  LinearTransition,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { useBond } from "@/state/store";
import { isType } from "@/model/messages";
import type { BondNode } from "@/model/node";
import { useTokens } from "@/theme";
import { enter, spring } from "@/theme/motion";
import { Screen } from "@/components/ui/Screen";
import { Txt } from "@/components/ui/Text";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Avatar } from "@/components/ui/Avatar";
import { PresenceDot } from "@/components/ui/PresenceDot";
import { BondMark } from "@/components/motion/BondMark";
import { AmbientGlow } from "@/components/motion/Ambient";
import { PressableScale } from "@/components/motion/PressableScale";

function timeAgo(iso: string | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** The plus that turns into a close on a spring. */
function NewRoomButton({ open, onPress }: { open: boolean; onPress: () => void }) {
  const { c } = useTokens();
  const r = useSharedValue(0);
  useEffect(() => {
    r.set(withSpring(open ? 1 : 0, spring.bouncy));
  }, [open, r]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${r.get() * 135}deg` }] }));
  return (
    <PressableScale
      testID="new-room-toggle"
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={open ? "Close new room" : "New room"}
      pressedScale={0.9}
      style={{
        width: 46,
        height: 46,
        borderRadius: 23,
        backgroundColor: c.brand,
        alignItems: "center",
        justifyContent: "center",
        boxShadow: `0px 10px 26px -8px ${c.glowBrand}`,
      }}
    >
      <Animated.View style={style}>
        <Ionicons name="add" size={26} color={c.onBrand} />
      </Animated.View>
    </PressableScale>
  );
}

export default function RoomsScreen() {
  const { c, space, radius } = useTokens();
  const rooms = useBond((s) => s.rooms);
  const nodes = useBond((s) => s.nodes);
  const members = useBond((s) => s.members);
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");

  const create = async () => {
    const room = await useBond.getState().createRoom(title);
    setTitle("");
    setCreating(false);
    router.push({ pathname: "/room/[roomId]", params: { roomId: room.id } });
  };

  const latest = (roomId: string): { text: string; at?: string; payment: boolean } => {
    const ns: BondNode[] = nodes[roomId] ?? [];
    if (ns.length === 0) return { text: "No messages yet", payment: false };
    // Show the latest thing a person would read: a text body or a payment, not the
    // agent's tool plumbing that follows its reply.
    for (let i = ns.length - 1; i >= 0; i--) {
      const n = ns[i]!;
      if (isType(n, "text") && n.payload.body) {
        return { text: n.payload.body.replace(/[*`]/g, "").trim(), at: n.createdAt, payment: false };
      }
      if (n.type === "payment") return { text: "Payment", at: n.createdAt, payment: true };
    }
    return { text: "…", payment: false };
  };

  return (
    <Screen edges={["top"]}>
      <AmbientGlow intensity={0.5} />
      <View
        style={{
          paddingHorizontal: space[4],
          paddingTop: space[3],
          paddingBottom: space[4],
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Animated.View entering={enter.hero(0)} style={{ flexDirection: "row", alignItems: "center", gap: space[3] }}>
          <BondMark size={26} animate delay={120} />
          <View>
            <Txt variant="display">Bond</Txt>
            <Txt variant="caption" muted>Humans and agents, together</Txt>
          </View>
        </Animated.View>
        <NewRoomButton open={creating} onPress={() => setCreating((v) => !v)} />
      </View>

      {creating ? (
        <Animated.View
          entering={enter.row(0)}
          exiting={FadeOutUp.duration(160).reduceMotion(ReduceMotion.System)}
          style={{ marginHorizontal: space[4], marginBottom: space[3] }}
        >
          <Card glow="brand" style={{ gap: space[3] }}>
            <Txt variant="label" color={c.brand}>New room</Txt>
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder="Room name"
              placeholderTextColor={c.textFaint}
              autoFocus
              onSubmitEditing={create}
              returnKeyType="done"
              style={{
                backgroundColor: c.surfaceAlt,
                borderWidth: 1,
                borderColor: c.brand + "55",
                borderRadius: radius.md,
                padding: space[3],
                color: c.text,
                fontSize: 16,
                outlineWidth: 0,
              }}
            />
            <Button title="Create room" onPress={create} />
          </Card>
        </Animated.View>
      ) : null}

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[8], gap: space[3] }}
        showsVerticalScrollIndicator={false}
      >
        {rooms.length === 0 ? (
          <Animated.View entering={enter.row(1)}>
            <Card style={{ alignItems: "center", gap: space[3], paddingVertical: space[8], paddingHorizontal: space[5] }}>
              <View style={{ height: 96, justifyContent: "center" }}>
                <BondMark size={40} animate rings breathe delay={300} />
              </View>
              <Txt variant="title" style={{ textAlign: "center" }}>No rooms yet</Txt>
              <Txt variant="body" muted style={{ textAlign: "center" }}>
                Create a room and message Bond. Every message is signed by your device identity.
              </Txt>
              <Button title="Create your first room" onPress={() => setCreating(true)} style={{ alignSelf: "stretch" }} />
            </Card>
          </Animated.View>
        ) : (
          rooms.map((room, i) => {
            const roster = members[room.id] ?? [];
            const agentCount = roster.filter((m) => m.kind === "agent").length;
            const last = latest(room.id);
            return (
              <Animated.View key={room.id} entering={enter.row(i)} layout={LinearTransition.springify().damping(20)}>
                <PressableScale
                  onPress={() => router.push({ pathname: "/room/[roomId]", params: { roomId: room.id } })}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${room.title}`}
                  pressedScale={0.975}
                >
                  <Card style={{ flexDirection: "row", alignItems: "center", gap: space[3] }}>
                    <View style={{ width: 48, height: 48 }}>
                      {roster.slice(0, 2).map((m, j) => (
                        <View key={m.did} style={{ position: "absolute", left: j * 18, top: j * 16 }}>
                          <Avatar did={m.did} name={m.displayName} kind={m.kind} size={30} ring={j > 0 ? c.surface : undefined} />
                        </View>
                      ))}
                    </View>
                    <View style={{ flex: 1, gap: 3 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
                        <Txt variant="heading" numberOfLines={1} style={{ flex: 1 }}>{room.title}</Txt>
                        <Txt variant="caption" faint>{timeAgo(last.at)}</Txt>
                      </View>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
                        {last.payment ? <Ionicons name="arrow-up-circle" size={14} color={c.brand} /> : null}
                        <Txt variant="body" muted numberOfLines={1} style={{ flex: 1, fontSize: 15 }}>{last.text}</Txt>
                        {agentCount > 0 ? (
                          <View
                            style={{
                              flexDirection: "row",
                              alignItems: "center",
                              gap: 5,
                              backgroundColor: c.agentSoft,
                              paddingHorizontal: space[2],
                              paddingVertical: 2,
                              borderRadius: radius.pill,
                            }}
                          >
                            <PresenceDot color={c.agent} size={6} live />
                            <Txt variant="caption" color={c.agent} style={{ fontSize: 12, lineHeight: 16 }}>{agentCount}</Txt>
                          </View>
                        ) : null}
                      </View>
                    </View>
                  </Card>
                </PressableScale>
              </Animated.View>
            );
          })
        )}
      </ScrollView>
    </Screen>
  );
}
