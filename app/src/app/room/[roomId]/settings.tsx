// Room settings. It shows who is in this room, what each member may do, then the one
// action that matters here: bring another agent in through a connected bridge. Humans
// and agents are both first-class members so they share one list. Agents are marked so
// they read apart at a glance. See DESIGN.md sec 6.
import { useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { Screen } from "@/components/ui/Screen";
import { Txt } from "@/components/ui/Text";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Avatar } from "@/components/ui/Avatar";
import { Pill } from "@/components/ui/Badge";
import { PresenceDot } from "@/components/ui/PresenceDot";
import { useTokens } from "@/theme";
import { useBond, type Bridge } from "@/state/store";
import { ROLE_LABEL, type Membership, type Role } from "@/rooms/roles";
import { ADAPTER_LIST } from "@/bridge/registry";

function roleTone(role: Role): "neutral" | "brand" | "agent" {
  if (role === "agent") return "agent";
  if (role === "owner" || role === "admin") return "brand";
  return "neutral";
}

function shortDid(did: string): string {
  const body = did.replace(/^did:/, "");
  if (body.length <= 16) return `did:${body}`;
  return `did:${body.slice(0, 8)}…${body.slice(-6)}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "recently";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// Stable empty list so memo dependencies do not change on every render.
const NO_MEMBERS: never[] = [];

export default function RoomSettingsScreen() {
  const { c, space, radius } = useTokens();
  const router = useRouter();
  const params = useLocalSearchParams();
  const raw = params.roomId;
  const roomId = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");

  const room = useBond((s) => s.rooms.find((r) => r.id === roomId));
  const members = useBond((s) => s.members[roomId]) ?? NO_MEMBERS;
  const bridges = useBond((s) => s.bridges);

  const [pickerOpen, setPickerOpen] = useState(false);

  const connectedBridges = useMemo(
    () => bridges.filter((b) => b.status === "connected"),
    [bridges],
  );
  const addedBridgeIds = useMemo(() => {
    const set = new Set<string>();
    for (const m of members) if (m.bridgeId) set.add(m.bridgeId);
    return set;
  }, [members]);
  // Humans first, then agents, so the list has a clear spine and agents cluster together.
  const ordered = useMemo(
    () => [...members].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "human" ? -1 : 1)),
    [members],
  );

  const blurbFor = (kind: Bridge["kind"]) =>
    ADAPTER_LIST.find((a) => a.kind === kind)?.blurb ?? "Connected agent bridge.";

  const handleAddAgent = (bridge: Bridge) => {
    void useBond.getState().addAgentToRoom(roomId, bridge, bridge.displayName);
    setPickerOpen(false);
  };

  const goBack = () => (router.canGoBack() ? router.back() : router.replace("/"));

  const header = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space[2],
        paddingHorizontal: space[4],
        paddingTop: space[2],
        paddingBottom: space[3],
      }}
    >
      <Pressable
        onPress={goBack}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Go back"
        style={({ pressed }) => ({
          width: 40,
          height: 40,
          borderRadius: radius.pill,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: c.surfaceAlt,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Ionicons name="chevron-back" size={20} color={c.text} />
      </Pressable>
      <Txt variant="heading">Room settings</Txt>
    </View>
  );
  if (!room) {
    return (
      <Screen edges={["top", "bottom"]}>
        {header}
        <View
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            padding: space[6],
            gap: space[2],
          }}
        >
          <Ionicons name="help-circle-outline" size={40} color={c.textFaint} />
          <Txt variant="heading">Room not found</Txt>
          <Txt variant="body" muted style={{ textAlign: "center" }}>
            This room may have been removed. Go back and pick another from your rooms.
          </Txt>
          <Button
            title="Back to rooms"
            variant="secondary"
            onPress={goBack}
            style={{ marginTop: space[2] }}
          />
        </View>
      </Screen>
    );
  }

  return (
    <Screen edges={["top", "bottom"]}>
      {header}
      <ScrollView
        contentContainerStyle={{
          padding: space[4],
          paddingTop: 0,
          gap: space[5],
          paddingBottom: space[8],
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* Room hero */}
        <View style={{ gap: space[1] }}>
          <Txt variant="caption" faint style={{ textTransform: "uppercase", letterSpacing: 0.8 }}>
            Room
          </Txt>
          <Txt variant="title">{room.title}</Txt>
          <Txt variant="caption" muted>
            {members.length} {members.length === 1 ? "member" : "members"} · created{" "}
            {formatDate(room.createdAt)}
          </Txt>
        </View>
        {/* Permission model, one line */}
        <Card sunken style={{ flexDirection: "row", gap: space[3], alignItems: "center" }}>
          <View
            style={{
              width: 36,
              height: 36,
              borderRadius: radius.md,
              backgroundColor: c.brandSoft,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ionicons name="shield-checkmark-outline" size={18} color={c.brand} />
          </View>
          <Txt variant="callout" muted style={{ flex: 1 }}>
            Agents can post and be mentioned. Humans approve gated tool calls.
          </Txt>
        </Card>

        {/* Members */}
        <View style={{ gap: space[3] }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
            <Txt
              variant="caption"
              faint
              style={{ textTransform: "uppercase", letterSpacing: 0.8 }}
            >
              Members
            </Txt>
            <Pill label={String(members.length)} tone="neutral" />
          </View>
          <Card style={{ padding: 0, overflow: "hidden" }}>
            {ordered.map((m, i) => (
              <MemberRow
                key={m.did}
                member={m}
                first={i === 0}
                bridgeName={bridges.find((b) => b.id === m.bridgeId)?.displayName}
                bridgeConnected={
                  m.kind === "agent" && !!m.bridgeId
                    ? connectedBridges.some((b) => b.id === m.bridgeId)
                    : false
                }
              />
            ))}
          </Card>
        </View>
        {/* Add an agent */}
        <View style={{ gap: space[3] }}>
          <Button
            title={pickerOpen ? "Cancel" : "Add an agent to this room"}
            variant={pickerOpen ? "secondary" : "primary"}
            left={
              <Ionicons
                name={pickerOpen ? "close" : "add"}
                size={18}
                color={pickerOpen ? c.text : "#FFFFFF"}
              />
            }
            onPress={() => setPickerOpen((v) => !v)}
          />
          {pickerOpen && (
            <Card sunken style={{ gap: space[3] }}>
              <View style={{ gap: space[1] }}>
                <Txt variant="callout">Connected bridges</Txt>
                <Txt variant="caption" muted>
                  Pick a bridge to add its agent as a member of this room.
                </Txt>
              </View>
              {connectedBridges.length === 0 ? (
                <View style={{ gap: space[3], alignItems: "flex-start" }}>
                  <Txt variant="body" muted>
                    No bridges are connected yet. Connect one, then add its agent here.
                  </Txt>
                  <Button
                    title="Connect a bridge"
                    variant="secondary"
                    left={<Ionicons name="git-network-outline" size={18} color={c.text} />}
                    onPress={() => router.push("/bridge/connect")}
                  />
                </View>
              ) : (
                <View style={{ gap: space[2] }}>
                  {connectedBridges.map((b) => (
                    <BridgeRow
                      key={b.id}
                      bridge={b}
                      blurb={blurbFor(b.kind)}
                      added={addedBridgeIds.has(b.id)}
                      onPress={() => handleAddAgent(b)}
                    />
                  ))}
                </View>
              )}
            </Card>
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}
function MemberRow({
  member,
  first,
  bridgeName,
  bridgeConnected,
}: {
  member: Membership;
  first: boolean;
  bridgeName?: string;
  bridgeConnected: boolean;
}) {
  const { c, space } = useTokens();
  const isAgent = member.kind === "agent";
  const showBridge = isAgent && !!bridgeName;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space[3],
        paddingVertical: space[3],
        paddingHorizontal: space[4],
        borderTopWidth: first ? 0 : 1,
        borderTopColor: c.border,
        backgroundColor: isAgent ? c.agentSoft : "transparent",
      }}
    >
      <Avatar did={member.did} name={member.displayName} kind={member.kind} size={40} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[1] }}>
          <Txt variant="callout" numberOfLines={1} style={{ flexShrink: 1 }}>
            {member.displayName}
          </Txt>
          {isAgent && <PresenceDot color={bridgeConnected ? c.online : c.textFaint} size={7} />}
        </View>
        <Txt variant={showBridge ? "caption" : "mono"} faint numberOfLines={1}>
          {showBridge ? `via ${bridgeName}` : shortDid(member.did)}
        </Txt>
      </View>
      <Pill label={ROLE_LABEL[member.role]} tone={roleTone(member.role)} />
    </View>
  );
}

function BridgeRow({
  bridge,
  blurb,
  added,
  onPress,
}: {
  bridge: Bridge;
  blurb: string;
  added: boolean;
  onPress: () => void;
}) {
  const { c, space, radius } = useTokens();
  return (
    <Pressable
      onPress={added ? undefined : onPress}
      disabled={added}
      accessibilityRole="button"
      accessibilityLabel={
        added ? `${bridge.displayName} is already in this room` : `Add ${bridge.displayName}`
      }
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: space[3],
        padding: space[3],
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.surface,
        opacity: added ? 0.6 : pressed ? 0.85 : 1,
      })}
    >
      <View
        style={{
          width: 38,
          height: 38,
          borderRadius: radius.md,
          backgroundColor: c.agentSoft,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Ionicons name="hardware-chip-outline" size={19} color={c.agent} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Txt variant="callout" numberOfLines={1}>
          {bridge.displayName}
        </Txt>
        <Txt variant="caption" muted numberOfLines={1}>
          {blurb}
        </Txt>
      </View>
      {added ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Ionicons name="checkmark-circle" size={16} color={c.verified} />
          <Txt variant="caption" color={c.verified}>
            Added
          </Txt>
        </View>
      ) : (
        <Ionicons name="add-circle" size={22} color={c.brand} />
      )}
    </Pressable>
  );
}
