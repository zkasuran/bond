import { useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useBond } from "@/state/store";
import { isType } from "@/model/messages";
import { useTokens } from "@/theme";
import { Screen } from "@/components/ui/Screen";
import { Txt } from "@/components/ui/Text";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { PresenceDot } from "@/components/ui/PresenceDot";

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

  const preview = (roomId: string): string => {
    const ns = nodes[roomId] ?? [];
    const last = ns[ns.length - 1];
    if (!last) return "No messages yet";
    return isType(last, "text") ? last.payload.body || "…" : `[${last.type}]`;
  };

  return (
    <Screen edges={["top"]}>
      <View style={{ paddingHorizontal: space[4], paddingTop: space[2], paddingBottom: space[3], flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <View>
          <Txt variant="display">Bond</Txt>
          <Txt variant="caption" muted>Humans and agents, together</Txt>
        </View>
        <Pressable
          onPress={() => setCreating((v) => !v)}
          style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: c.brand, alignItems: "center", justifyContent: "center" }}
        >
          <Ionicons name={creating ? "close" : "add"} size={24} color="#fff" />
        </Pressable>
      </View>

      {creating ? (
        <Card style={{ marginHorizontal: space[4], marginBottom: space[3], gap: space[3] }}>
          <Txt variant="heading">New room</Txt>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="Room name"
            placeholderTextColor={c.textFaint}
            autoFocus
            style={{ backgroundColor: c.surfaceAlt, borderRadius: radius.md, padding: space[3], color: c.text, fontSize: 16 }}
          />
          <Button title="Create room" onPress={create} />
        </Card>
      ) : null}

      <ScrollView contentContainerStyle={{ paddingHorizontal: space[4], paddingBottom: space[8], gap: space[3] }}>
        {rooms.length === 0 ? (
          <Card style={{ alignItems: "center", gap: space[3], paddingVertical: space[8] }}>
            <Ionicons name="chatbubbles-outline" size={40} color={c.textFaint} />
            <Txt variant="heading">No rooms yet</Txt>
            <Txt variant="body" muted style={{ textAlign: "center" }}>
              Create a room and message Bond. Every message is signed by your device identity.
            </Txt>
            <Button title="Create your first room" onPress={() => setCreating(true)} />
          </Card>
        ) : (
          rooms.map((room) => {
            const agentCount = (members[room.id] ?? []).filter((m) => m.kind === "agent").length;
            return (
              <Pressable
                key={room.id}
                onPress={() => router.push({ pathname: "/room/[roomId]", params: { roomId: room.id } })}
              >
                <Card style={{ gap: 6 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                    <Txt variant="heading" numberOfLines={1} style={{ flex: 1 }}>{room.title}</Txt>
                    {agentCount > 0 ? (
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                        <PresenceDot color={c.agent} />
                        <Txt variant="caption" color={c.agent}>{agentCount}</Txt>
                      </View>
                    ) : null}
                  </View>
                  <Txt variant="body" muted numberOfLines={1}>{preview(room.id)}</Txt>
                </Card>
              </Pressable>
            );
          })
        )}
      </ScrollView>
    </Screen>
  );
}
