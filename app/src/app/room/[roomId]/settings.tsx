// Room settings. It shows who is in this room, what each member may do, then the one
// action that matters here: bring another agent in through a connected bridge and give it a
// job, what it should pursue in this room. A bridge can be added more than once, so a room
// can run several agents from one runtime, each with its own job. Tapping an agent in the
// member list edits its job. Humans and agents are both first-class members so they share
// one list. Agents are marked so they read apart at a glance. See DESIGN.md sec 6.
import { useMemo, useState } from "react";
import { Pressable, ScrollView, TextInput, View, type TextInputProps } from "react-native";
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
import { MAX_AGENT_JOB_CHARS, MAX_AGENT_NAME_CHARS, uniqueAgentName } from "@/rooms/agents";
import { useAndroidKeyboardInset } from "@/hooks/use-keyboard-inset";

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

  const keyboardInset = useAndroidKeyboardInset();
  const [pickerOpen, setPickerOpen] = useState(false);
  // The bridge picked in the add flow; while set, the name and job form shows.
  const [draftBridge, setDraftBridge] = useState<Bridge | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftJob, setDraftJob] = useState("");
  const [adding, setAdding] = useState(false);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  // The agent whose job is being edited in the member list.
  const [editingDid, setEditingDid] = useState<string | null>(null);

  const connectedBridges = useMemo(
    () => bridges.filter((b) => b.status === "connected"),
    [bridges],
  );
  // How many agents each bridge already has here. Shown, never used to block: the same
  // bridge can be added again for a different job.
  const agentsPerBridge = useMemo(() => {
    const count = new Map<string, number>();
    for (const m of members) {
      if (m.kind === "agent" && m.bridgeId) count.set(m.bridgeId, (count.get(m.bridgeId) ?? 0) + 1);
    }
    return count;
  }, [members]);
  // Humans first, then agents, so the list has a clear spine and agents cluster together.
  const ordered = useMemo(
    () => [...members].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "human" ? -1 : 1)),
    [members],
  );

  const blurbFor = (kind: Bridge["kind"]) =>
    ADAPTER_LIST.find((a) => a.kind === kind)?.blurb ?? "Connected agent bridge.";

  const closePicker = () => {
    setPickerOpen(false);
    setDraftBridge(null);
    setDraftName("");
    setDraftJob("");
  };

  const pickBridge = (bridge: Bridge) => {
    setDraftBridge(bridge);
    // "Bond gateway" names the transport; the agent itself is "Bond" (then "Bond 2", ...).
    const base = bridge.displayName.replace(/\s+(gateway|bridge)$/i, "") || bridge.displayName;
    setDraftName(uniqueAgentName(base, members));
    setDraftJob("");
    setJustAdded(null);
  };

  const handleAddAgent = async () => {
    if (!draftBridge || adding) return;
    setAdding(true);
    try {
      const mem = await useBond
        .getState()
        .addAgentToRoom(roomId, draftBridge, draftName || draftBridge.displayName, draftJob);
      setJustAdded(mem.displayName);
      closePicker();
    } finally {
      setAdding(false);
    }
  };

  const saveJob = async (did: string, job: string) => {
    await useBond.getState().updateAgentJob(roomId, did, job);
    setEditingDid(null);
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
        style={{ flex: 1, marginBottom: keyboardInset }}
        keyboardShouldPersistTaps="handled"
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
            Agents can post and be mentioned. Humans approve gated tool calls. Tap an agent to
            set what it should pursue here.
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
                editing={editingDid === m.did}
                onToggleEdit={
                  m.kind === "agent"
                    ? () => setEditingDid((d) => (d === m.did ? null : m.did))
                    : undefined
                }
                onSaveJob={(job) => saveJob(m.did, job)}
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
                color={pickerOpen ? c.text : c.onBrand}
              />
            }
            onPress={() => {
              if (pickerOpen) {
                closePicker();
              } else {
                setPickerOpen(true);
                setJustAdded(null);
              }
            }}
          />
          {justAdded && !pickerOpen && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space[1] }}>
              <Ionicons name="checkmark-circle" size={16} color={c.verified} />
              <Txt variant="caption" color={c.verified} style={{ flex: 1 }}>
                {justAdded} joined this room. Mention it with its @ chip in the thread.
              </Txt>
            </View>
          )}
          {pickerOpen && draftBridge && (
            <Card sunken style={{ gap: space[3] }}>
              <View style={{ gap: space[1] }}>
                <Txt variant="callout">New agent via {draftBridge.displayName}</Txt>
                <Txt variant="caption" muted>
                  Give it a name and the job it should pursue in this room.
                </Txt>
              </View>
              <Field
                label="Name"
                value={draftName}
                onChangeText={setDraftName}
                maxLength={MAX_AGENT_NAME_CHARS}
                autoCapitalize="words"
                accessibilityLabel="Agent name"
              />
              <Field
                label="Job (optional)"
                value={draftJob}
                onChangeText={setDraftJob}
                maxLength={MAX_AGENT_JOB_CHARS}
                multiline
                placeholder="For example: watch this room's payments and post a short summary when one lands."
                accessibilityLabel="Agent job"
                hint={`${draftJob.length}/${MAX_AGENT_JOB_CHARS}. Sent with every turn. Spend caps still apply.`}
              />
              <View style={{ flexDirection: "row", gap: space[2] }}>
                <Button
                  title="Back"
                  variant="secondary"
                  onPress={() => setDraftBridge(null)}
                  style={{ flex: 1 }}
                />
                <Button
                  title={adding ? "Adding…" : "Add agent"}
                  onPress={() => void handleAddAgent()}
                  disabled={adding || !draftName.trim()}
                  style={{ flex: 1 }}
                />
              </View>
            </Card>
          )}
          {pickerOpen && !draftBridge && (
            <Card sunken style={{ gap: space[3] }}>
              <View style={{ gap: space[1] }}>
                <Txt variant="callout">Connected bridges</Txt>
                <Txt variant="caption" muted>
                  Pick a bridge, then give its agent a job. A bridge can be added more than once.
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
                      inRoom={agentsPerBridge.get(b.id) ?? 0}
                      onPress={() => pickBridge(b)}
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
  editing,
  onToggleEdit,
  onSaveJob,
}: {
  member: Membership;
  first: boolean;
  bridgeName?: string;
  bridgeConnected: boolean;
  editing: boolean;
  /** Set for agent members: toggles the job editor. */
  onToggleEdit?: () => void;
  onSaveJob: (job: string) => void | Promise<void>;
}) {
  const { c, space } = useTokens();
  const isAgent = member.kind === "agent";
  const showBridge = isAgent && !!bridgeName;
  const [draft, setDraft] = useState(member.job ?? "");
  const toggle = onToggleEdit
    ? () => {
        setDraft(member.job ?? "");
        onToggleEdit();
      }
    : undefined;
  return (
    <View
      style={{
        borderTopWidth: first ? 0 : 1,
        borderTopColor: c.border,
        backgroundColor: isAgent ? c.agentSoft : "transparent",
      }}
    >
      <Pressable
        onPress={toggle}
        disabled={!toggle}
        accessibilityRole={toggle ? "button" : undefined}
        accessibilityLabel={
          toggle
            ? `${member.displayName}. ${member.job ? `Job: ${member.job}` : "No job set"}. Edit job`
            : undefined
        }
        accessibilityState={toggle ? { expanded: editing } : undefined}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space[3],
          paddingVertical: space[3],
          paddingHorizontal: space[4],
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
          {isAgent && (
            <Txt
              variant="caption"
              muted={!!member.job}
              faint={!member.job}
              numberOfLines={editing ? undefined : 2}
            >
              {member.job ? `Job: ${member.job}` : "No job set. Tap to give it one."}
            </Txt>
          )}
        </View>
        <Pill label={ROLE_LABEL[member.role]} tone={roleTone(member.role)} />
      </Pressable>
      {editing && (
        <View style={{ gap: space[2], paddingHorizontal: space[4], paddingBottom: space[3] }}>
          <Field
            label={`What should ${member.displayName} pursue in this room?`}
            value={draft}
            onChangeText={setDraft}
            maxLength={MAX_AGENT_JOB_CHARS}
            multiline
            autoFocus
            placeholder="For example: track devnet USDC sent in this room and flag anything over 5 USDC."
            accessibilityLabel={`Job for ${member.displayName}`}
            hint={`${draft.length}/${MAX_AGENT_JOB_CHARS}. Leave empty to clear the job.`}
          />
          <View style={{ flexDirection: "row", gap: space[2] }}>
            <Button title="Cancel" variant="secondary" onPress={toggle} style={{ flex: 1 }} />
            <Button title="Save job" onPress={() => void onSaveJob(draft)} style={{ flex: 1 }} />
          </View>
        </View>
      )}
    </View>
  );
}

function Field({
  label,
  hint,
  multiline,
  ...props
}: TextInputProps & { label: string; hint?: string }) {
  const { c, radius, space, font } = useTokens();
  return (
    <View style={{ gap: space[1] }}>
      <Txt variant="caption" muted>
        {label}
      </Txt>
      <TextInput
        placeholderTextColor={c.textFaint}
        multiline={multiline}
        textAlignVertical={multiline ? "top" : "center"}
        {...props}
        style={{
          backgroundColor: c.surface,
          borderColor: c.border,
          borderWidth: 1,
          borderRadius: radius.md,
          paddingHorizontal: space[3],
          paddingVertical: space[3],
          minHeight: multiline ? 96 : undefined,
          color: c.text,
          fontSize: 15,
          fontFamily: font.sans,
        }}
      />
      {hint ? (
        <Txt variant="caption" faint>
          {hint}
        </Txt>
      ) : null}
    </View>
  );
}

function BridgeRow({
  bridge,
  blurb,
  inRoom,
  onPress,
}: {
  bridge: Bridge;
  blurb: string;
  /** How many agents from this bridge are already in the room. Informational only. */
  inRoom: number;
  onPress: () => void;
}) {
  const { c, space, radius } = useTokens();
  const here =
    inRoom === 0 ? null : inRoom === 1 ? "1 agent already here" : `${inRoom} agents already here`;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Add an agent via ${bridge.displayName}${here ? `, ${here}` : ""}`}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: space[3],
        padding: space[3],
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.surface,
        opacity: pressed ? 0.85 : 1,
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
          {here ? `${blurb} · ${here}` : blurb}
        </Txt>
      </View>
      <Ionicons name="add-circle" size={22} color={c.brand} />
    </Pressable>
  );
}
