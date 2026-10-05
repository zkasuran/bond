// The Agents tab. Bond's universal bridge surface: every connected runtime shows here
// as a card with its live status and the capabilities it actually reported. One primary
// action, connect another bridge, routes to the connect modal. See DESIGN.md sec 4.
import { ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTokens } from "@/theme";
import { Txt } from "@/components/ui/Text";
import { Screen } from "@/components/ui/Screen";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Avatar } from "@/components/ui/Avatar";
import { Pill } from "@/components/ui/Badge";
import { PresenceDot } from "@/components/ui/PresenceDot";
import { AmbientGlow, Reveal } from "@/components/motion/Ambient";
import { ADAPTER_LIST } from "@/bridge/registry";
import { useBond, type Bridge } from "@/state/store";

type PillTone = "neutral" | "brand" | "agent";

const ADAPTER_LABEL: Record<string, string> = Object.fromEntries(
  ADAPTER_LIST.map((a) => [a.kind, a.displayName]),
);

/** Turn the capabilities a bridge reported at connect time into readable pills. */
function capabilityPills(caps: Bridge["capabilities"]): { label: string; tone: PillTone }[] {
  if (!caps) return [];
  const pills: { label: string; tone: PillTone }[] = [];
  if (caps.streaming) pills.push({ label: "streaming", tone: "brand" });
  if (caps.tools && caps.tools !== "none") {
    pills.push({ label: `tools: ${caps.tools}`, tone: "agent" });
  }
  if (caps.multiAgent) pills.push({ label: "multi-agent", tone: "agent" });
  if (caps.sessions) pills.push({ label: "sessions", tone: "neutral" });
  if (caps.threading) pills.push({ label: "threading", tone: "neutral" });
  if (caps.identity && caps.identity !== "none") {
    pills.push({ label: `identity: ${caps.identity}`, tone: "brand" });
  }
  return pills;
}

function BridgeCard({ bridge }: { bridge: Bridge }) {
  const { c, space, radius } = useTokens();
  const status = {
    connected: { color: c.online, label: "Connected" },
    connecting: { color: c.warning, label: "Connecting" },
    error: { color: c.tampered, label: "Error" },
  }[bridge.status];
  const pills = capabilityPills(bridge.capabilities);
  const isBond = bridge.kind === "bond";

  return (
    <Card style={{ gap: space[3] }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space[3] }}>
        <Avatar did={bridge.id} name={bridge.displayName} kind="agent" size={44} />
        <View style={{ flex: 1, gap: space[1] }}>
          <Txt variant="heading" numberOfLines={1}>
            {bridge.displayName}
          </Txt>
          <Txt variant="caption" faint>
            {ADAPTER_LABEL[bridge.kind] ?? bridge.kind}
          </Txt>
        </View>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            backgroundColor: c.surfaceAlt,
            paddingHorizontal: space[2],
            paddingVertical: 4,
            borderRadius: radius.pill,
          }}
        >
          <PresenceDot color={status.color} size={7} live={bridge.status !== "error"} />
          <Txt variant="caption" color={status.color}>
            {status.label}
          </Txt>
        </View>
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Ionicons
          name={isBond ? "sparkles-outline" : "globe-outline"}
          size={13}
          color={c.textFaint}
        />
        <Txt variant={isBond ? "caption" : "mono"} faint numberOfLines={1} style={{ flex: 1 }}>
          {isBond ? "Built in agent, zero setup" : bridge.config.baseUrl || "No base URL set"}
        </Txt>
      </View>
      {pills.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[2] }}>
          {pills.map((p) => (
            <Pill key={p.label} label={p.label} tone={p.tone} />
          ))}
        </View>
      ) : null}

      {bridge.status === "error" && bridge.error ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "flex-start",
            gap: 6,
            backgroundColor: c.tamperedSoft,
            padding: space[3],
            borderRadius: radius.md,
          }}
        >
          <Ionicons name="warning" size={14} color={c.tampered} style={{ marginTop: 1 }} />
          <Txt variant="caption" color={c.tampered} style={{ flex: 1 }}>
            {bridge.error}
          </Txt>
        </View>
      ) : null}
    </Card>
  );
}
export default function AgentsScreen() {
  const { c, space } = useTokens();
  const router = useRouter();
  const bridges = useBond((s) => s.bridges);
  const liveCount = bridges.filter((b) => b.status === "connected").length;

  return (
    <Screen padded>
      <AmbientGlow intensity={0.4} />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ gap: space[5], paddingBottom: space[8] }}
      >
        <Reveal index={0} style={{ gap: space[2] }}>
          <Txt variant="label" color={c.agent}>Universal bridge</Txt>
          <Txt variant="display">Agents</Txt>
          <Txt variant="body" muted>
            Bond bridges to Hermes, OpenClaw, your own gateway or any OpenAI-compatible runtime.
          </Txt>
        </Reveal>

        <Button
          title="Connect a bridge"
          onPress={() => router.push("/bridge/connect")}
          left={<Ionicons name="add" size={18} color={c.onBrand} />}
        />

        <View style={{ gap: space[3] }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <Txt variant="heading">Bridges</Txt>
            <Pill label={`${liveCount} of ${bridges.length} live`} tone="neutral" />
          </View>

          {bridges.length === 0 ? (
            <Card sunken style={{ alignItems: "center", gap: space[2], paddingVertical: space[7] }}>
              <Ionicons name="hardware-chip-outline" size={28} color={c.textFaint} />
              <Txt variant="callout" muted>
                No bridges yet
              </Txt>
              <Txt variant="caption" faint style={{ textAlign: "center" }}>
                Connect a runtime to bring an agent into your rooms.
              </Txt>
            </Card>
          ) : (
            bridges.map((b, i) => (
              <Reveal key={b.id} index={i + 1}>
                <BridgeCard bridge={b} />
              </Reveal>
            ))
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}
