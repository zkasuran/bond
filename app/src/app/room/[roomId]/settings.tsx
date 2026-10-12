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
import {
  MAX_AGENT_JOB_CHARS,
  MAX_AGENT_NAME_CHARS,
  MAX_AGENT_PERSONA_CHARS,
  MAX_HANDLE_CHARS,
  handleProblem,
  normalizeHandle,
  suggestHandle,
  uniqueAgentName,
  type AgentProfile,
} from "@/rooms/agents";
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
  const agentDirectory = useBond((s) => s.agents);

  const keyboardInset = useAndroidKeyboardInset();
  const [pickerOpen, setPickerOpen] = useState(false);
  // The bridge picked in the add flow; while set, the name and job form shows.
  const [draftBridge, setDraftBridge] = useState<Bridge | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftHandle, setDraftHandle] = useState("");
  // Set once the user edits the handle, so typing the name stops re-suggesting it.
  const [handleTouched, setHandleTouched] = useState(false);
  const [draftPersona, setDraftPersona] = useState("");
  const [draftJob, setDraftJob] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  // "Bring in one of your agents" by @handle.
  const [importHandle, setImportHandle] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
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

  const allHandles = useMemo(
    () => Object.values(agentDirectory).map((a) => a.handle),
    [agentDirectory],
  );
  // Your agents that are not in this room yet: the ones you can bring in by @handle.
  const importable = useMemo(
    () =>
      Object.values(agentDirectory)
        .filter((a) => !members.some((m) => m.did === a.did))
        .sort((a, b) => a.handle.localeCompare(b.handle)),
    [agentDirectory, members],
  );
  const importMatches = useMemo(() => {
    const q = normalizeHandle(importHandle);
    return importable.filter(
      (a) => !q || a.handle.startsWith(q) || a.displayName.toLowerCase().startsWith(q),
    );
  }, [importable, importHandle]);
  const draftHandleProblem = draftHandle ? handleProblem(draftHandle, allHandles) : null;

  const blurbFor = (kind: Bridge["kind"]) =>
    ADAPTER_LIST.find((a) => a.kind === kind)?.blurb ?? "Connected agent bridge.";

  const closePicker = () => {
    setPickerOpen(false);
    setDraftBridge(null);
    setDraftName("");
    setDraftHandle("");
    setHandleTouched(false);
    setDraftPersona("");
    setDraftJob("");
    setAddError(null);
    setImportHandle("");
    setImportError(null);
  };

  const pickBridge = (bridge: Bridge) => {
    setDraftBridge(bridge);
    // "Bond gateway" names the transport; the agent itself is "Bond" (then "Bond 2", ...).
    const base = bridge.displayName.replace(/\s+(gateway|bridge)$/i, "") || bridge.displayName;
    const name = uniqueAgentName(base, members);
    setDraftName(name);
    setDraftHandle(suggestHandle(name, allHandles));
    setHandleTouched(false);
    setDraftPersona("");
    setDraftJob("");
    setAddError(null);
    setJustAdded(null);
  };

  const onDraftName = (name: string) => {
    setDraftName(name);
    if (!handleTouched) setDraftHandle(suggestHandle(name || "agent", allHandles));
  };

  const handleAddAgent = async () => {
    if (!draftBridge || adding) return;
    setAdding(true);
    try {
      const mem = await useBond.getState().createAgent(roomId, draftBridge, {
        displayName: draftName || draftBridge.displayName,
        handle: draftHandle,
        persona: draftPersona,
        job: draftJob,
      });
      setJustAdded(`${mem.displayName} (@${mem.handle})`);
      closePicker();
    } catch (e) {
      setAddError(String((e as Error)?.message ?? e));
    } finally {
      setAdding(false);
    }
  };

  const handleImport = async (handle: string) => {
    if (adding) return;
    setAdding(true);
    setImportError(null);
    try {
      const mem = await useBond.getState().importAgent(roomId, handle);
      setJustAdded(`${mem.displayName} (@${mem.handle})`);
      closePicker();
    } catch (e) {
      setImportError(String((e as Error)?.message ?? e));
    } finally {
      setAdding(false);
    }
  };

  const saveAgent = async (did: string, job: string, persona: string | null) => {
    await useBond.getState().updateAgentJob(roomId, did, job);
    if (persona !== null) await useBond.getState().updateAgentPersona(did, persona);
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
                profile={agentDirectory[m.did]}
                onSave={(job, persona) => saveAgent(m.did, job, persona)}
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
                {justAdded} joined this room. Type its @username in the thread to talk to it.
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
                onChangeText={onDraftName}
                maxLength={MAX_AGENT_NAME_CHARS}
                autoCapitalize="words"
                accessibilityLabel="Agent name"
              />
              <Field
                label="Username"
                value={draftHandle ? `@${draftHandle}` : ""}
                onChangeText={(t) => {
                  setHandleTouched(true);
                  setDraftHandle(normalizeHandle(t));
                }}
                maxLength={MAX_HANDLE_CHARS + 1}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="@payments_watcher"
                accessibilityLabel="Agent username"
                hint={
                  draftHandleProblem ??
                  `Type @${draftHandle || "username"} in any room to talk to it, or bring it into another room.`
                }
                hintTone={draftHandleProblem ? "error" : undefined}
              />
              <Field
                label="Persona (optional)"
                value={draftPersona}
                onChangeText={setDraftPersona}
                maxLength={MAX_AGENT_PERSONA_CHARS}
                multiline
                placeholder="Who it is and how it talks. For example: a calm treasury analyst who answers in three bullets."
                accessibilityLabel="Agent persona"
                hint={`${draftPersona.length}/${MAX_AGENT_PERSONA_CHARS}. Kept in every room it joins.`}
              />
              <Field
                label="Job (optional)"
                value={draftJob}
                onChangeText={setDraftJob}
                maxLength={MAX_AGENT_JOB_CHARS}
                multiline
                placeholder="For example: watch this room's payments and post a short summary when one lands."
                accessibilityLabel="Agent job"
                hint={`${draftJob.length}/${MAX_AGENT_JOB_CHARS}. Only for this room. Spend caps still apply.`}
              />
              {addError ? (
                <Txt variant="caption" color={c.tampered}>
                  {addError}
                </Txt>
              ) : null}
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
                  disabled={adding || !draftName.trim() || !!draftHandleProblem || !draftHandle}
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
                  Create a new agent on a bridge, or bring in one you already made.
                </Txt>
              </View>
              {Object.keys(agentDirectory).length > 0 ? (
                <View style={{ gap: space[2] }}>
                  <Field
                    label="Bring in one of your agents"
                    value={importHandle}
                    onChangeText={(t) => {
                      setImportHandle(t);
                      setImportError(null);
                    }}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="@username"
                    accessibilityLabel="Agent username to bring in"
                    onSubmitEditing={() => void handleImport(importHandle)}
                    returnKeyType="done"
                  />
                  {importError ? (
                    <Txt variant="caption" color={c.tampered}>
                      {importError}
                    </Txt>
                  ) : null}
                  {importable.length === 0 ? (
                    <Txt variant="caption" faint>
                      All your agents are already in this room.
                    </Txt>
                  ) : (
                    importMatches.slice(0, 5).map((a) => (
                      <ImportRow key={a.did} agent={a} onPress={() => void handleImport(a.handle)} />
                    ))
                  )}
                  <Txt variant="caption" faint style={{ marginTop: space[1] }}>
                    Or create a new one:
                  </Txt>
                </View>
              ) : null}
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
  profile,
  onSave,
}: {
  member: Membership;
  first: boolean;
  bridgeName?: string;
  bridgeConnected: boolean;
  editing: boolean;
  /** Set for agent members: toggles the job and persona editor. */
  onToggleEdit?: () => void;
  /** The agent's profile when it is one of yours; its persona is editable here. */
  profile?: AgentProfile;
  /** Save the job for this room and, when the agent has a profile, its persona (null: keep). */
  onSave: (job: string, persona: string | null) => void | Promise<void>;
}) {
  const { c, space } = useTokens();
  const isAgent = member.kind === "agent";
  const showBridge = isAgent && !!bridgeName;
  const [draft, setDraft] = useState(member.job ?? "");
  const [personaDraft, setPersonaDraft] = useState(profile?.persona ?? "");
  const toggle = onToggleEdit
    ? () => {
        setDraft(member.job ?? "");
        setPersonaDraft(profile?.persona ?? "");
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
            {showBridge
              ? `${member.handle ? `@${member.handle} · ` : ""}via ${bridgeName}`
              : shortDid(member.did)}
          </Txt>
          {isAgent && profile?.persona ? (
            <Txt variant="caption" muted numberOfLines={editing ? undefined : 1}>
              Persona: {profile.persona}
            </Txt>
          ) : null}
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
          {profile ? (
            <Field
              label={`Persona of ${member.displayName} (every room)`}
              value={personaDraft}
              onChangeText={setPersonaDraft}
              maxLength={MAX_AGENT_PERSONA_CHARS}
              multiline
              placeholder="Who it is and how it talks."
              accessibilityLabel={`Persona for ${member.displayName}`}
              hint={`${personaDraft.length}/${MAX_AGENT_PERSONA_CHARS}. Leave empty for none.`}
            />
          ) : null}
          <Field
            label={`What should ${member.displayName} pursue in this room?`}
            value={draft}
            onChangeText={setDraft}
            maxLength={MAX_AGENT_JOB_CHARS}
            multiline
            placeholder="For example: track devnet USDC sent in this room and flag anything over 5 USDC."
            accessibilityLabel={`Job for ${member.displayName}`}
            hint={`${draft.length}/${MAX_AGENT_JOB_CHARS}. Leave empty to clear the job.`}
          />
          <View style={{ flexDirection: "row", gap: space[2] }}>
            <Button title="Cancel" variant="secondary" onPress={toggle} style={{ flex: 1 }} />
            <Button
            title="Save"
            onPress={() => void onSave(draft, profile ? personaDraft : null)}
            style={{ flex: 1 }}
          />
          </View>
        </View>
      )}
    </View>
  );
}

function Field({
  label,
  hint,
  hintTone,
  multiline,
  ...props
}: TextInputProps & { label: string; hint?: string; hintTone?: "error" }) {
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
        hintTone === "error" ? (
          <Txt variant="caption" color={c.tampered}>
            {hint}
          </Txt>
        ) : (
          <Txt variant="caption" faint>
            {hint}
          </Txt>
        )
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

/** One of your agents that can be brought into this room. */
function ImportRow({ agent, onPress }: { agent: AgentProfile; onPress: () => void }) {
  const { c, space, radius } = useTokens();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Bring in @${agent.handle}, ${agent.displayName}`}
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
      <Avatar did={agent.did} name={agent.displayName} kind="agent" size={34} />
      <View style={{ flex: 1, gap: 2 }}>
        <Txt variant="callout" numberOfLines={1}>
          {agent.displayName} <Txt variant="caption" faint>@{agent.handle}</Txt>
        </Txt>
        <Txt variant="caption" muted numberOfLines={1}>
          {agent.persona ? agent.persona : "No persona set"}
        </Txt>
      </View>
      <Ionicons name="enter-outline" size={20} color={c.brand} />
    </Pressable>
  );
}
