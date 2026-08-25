// The connect-a-bridge modal. Pick a runtime, give it a base URL and key if it needs
// one, then Bond probes it live and adds it as a bridge. The built in Bond agent needs
// no config. On a failed probe the returned error shows inline. See DESIGN.md sec 4.
import { useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTokens } from "@/theme";
import { Txt } from "@/components/ui/Text";
import { Screen } from "@/components/ui/Screen";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Badge";
import { ADAPTER_LIST, type AdapterInfo } from "@/bridge/registry";
import { useBond } from "@/state/store";
import type { AdapterKind, GatewayConfig } from "@/bridge/adapter";

const ICON: Record<AdapterKind, keyof typeof Ionicons.glyphMap> = {
  bond: "sparkles",
  generic: "swap-horizontal",
  hermes: "flash",
  openclaw: "hardware-chip",
};

function Field({
  label,
  mono,
  ...props
}: TextInputProps & { label: string; mono?: boolean }) {
  const { c, radius, space, font } = useTokens();
  return (
    <View style={{ gap: space[2] }}>
      <Txt variant="caption" muted>
        {label}
      </Txt>
      <TextInput
        placeholderTextColor={c.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        {...props}
        style={{
          backgroundColor: c.surface,
          borderColor: c.border,
          borderWidth: 1,
          borderRadius: radius.md,
          paddingHorizontal: space[3],
          paddingVertical: space[3],
          color: c.text,
          fontSize: 15,
          fontFamily: mono ? font.mono : font.sans,
        }}
      />
    </View>
  );
}

export default function ConnectBridgeScreen() {
  const { c, space, radius } = useTokens();
  const router = useRouter();
  const [kind, setKind] = useState<AdapterKind | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(() => ADAPTER_LIST.find((a) => a.kind === kind) ?? null, [kind]);
  const needsBaseUrl = selected?.requiresConfig === true;
  const canConnect = !!selected && !connecting && (!needsBaseUrl || baseUrl.trim().length > 0);

  function select(info: AdapterInfo) {
    setKind(info.kind);
    setBaseUrl(info.defaults?.baseUrl ?? "");
    setApiKey("");
    setModel("");
    setError(null);
  }

  async function connect() {
    if (!selected) return;
    setConnecting(true);
    setError(null);
    try {
      let config: GatewayConfig;
      if (selected.kind === "bond") {
        // Bond needs no user config: reuse the working gateway config it already holds.
        const existing = useBond.getState().bridges.find((b) => b.id === "bond");
        config = existing?.config ?? { baseUrl: baseUrl.trim() };
      } else {
        config = {
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim() || undefined,
          model: model.trim() || undefined,
        };
      }
      const bridge = await useBond
        .getState()
        .connectBridge(selected.kind, config, selected.displayName);
      if (bridge.status === "error") {
        setError(bridge.error ?? "Could not reach this runtime. Check the base URL and key.");
      } else {
        router.back();
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setConnecting(false);
    }
  }
  return (
    <Screen padded>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: space[4],
        }}
      >
        <View style={{ flex: 1, paddingRight: space[3] }}>
          <Txt variant="title">Connect a bridge</Txt>
          <Txt variant="caption" muted>
            Pick a runtime to bring into Bond.
          </Txt>
        </View>
        <Pressable
          onPress={() => router.back()}
          hitSlop={8}
          style={{
            width: 34,
            height: 34,
            borderRadius: 17,
            backgroundColor: c.surfaceAlt,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Ionicons name="close" size={18} color={c.textMuted} />
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          style={{ flex: 1 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ gap: space[3], paddingBottom: space[6] }}
        >
          {ADAPTER_LIST.map((info) => {
            const isSel = info.kind === kind;
            return (
              <Pressable key={info.kind} onPress={() => select(info)}>
                <Card
                  style={{
                    borderColor: isSel ? c.brand : c.border,
                    borderWidth: isSel ? 2 : 1,
                    backgroundColor: isSel ? c.brandSoft : c.surface,
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: space[3] }}>
                    <View
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: radius.md,
                        backgroundColor: isSel ? c.brand : c.surfaceAlt,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Ionicons
                        name={ICON[info.kind]}
                        size={20}
                        color={isSel ? "#FFFFFF" : c.textMuted}
                      />
                    </View>
                    <View style={{ flex: 1, gap: 2 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
                        <Txt variant="heading">{info.displayName}</Txt>
                        {!info.requiresConfig ? <Pill label="No setup" tone="brand" /> : null}
                      </View>
                      <Txt variant="caption" muted>
                        {info.blurb}
                      </Txt>
                    </View>
                    {isSel ? (
                      <Ionicons name="checkmark-circle" size={20} color={c.brand} />
                    ) : null}
                  </View>
                </Card>
              </Pressable>
            );
          })}
          {selected && needsBaseUrl ? (
            <View style={{ gap: space[3], marginTop: space[1] }}>
              <Field
                label="Base URL"
                mono
                value={baseUrl}
                onChangeText={setBaseUrl}
                placeholder="https://host:port/v1"
                keyboardType="url"
              />
              <Field
                label="API key"
                mono
                value={apiKey}
                onChangeText={setApiKey}
                placeholder="Optional for local runtimes"
                secureTextEntry
              />
              <Field
                label="Model"
                mono
                value={model}
                onChangeText={setModel}
                placeholder="Optional, the runtime default is used"
              />
            </View>
          ) : null}

          {selected && !needsBaseUrl ? (
            <Card
              sunken
              style={{
                flexDirection: "row",
                gap: space[2],
                alignItems: "flex-start",
                marginTop: space[1],
              }}
            >
              <Ionicons
                name="information-circle-outline"
                size={16}
                color={c.textMuted}
                style={{ marginTop: 1 }}
              />
              <Txt variant="caption" muted style={{ flex: 1 }}>
                The built in Bond agent needs no setup. Connect it and it works the moment you open
                a room.
              </Txt>
            </Card>
          ) : null}

          {error ? (
            <View
              style={{
                flexDirection: "row",
                gap: 6,
                alignItems: "flex-start",
                backgroundColor: c.tamperedSoft,
                padding: space[3],
                borderRadius: radius.md,
              }}
            >
              <Ionicons name="warning" size={14} color={c.tampered} style={{ marginTop: 1 }} />
              <Txt variant="caption" color={c.tampered} style={{ flex: 1 }}>
                {error}
              </Txt>
            </View>
          ) : null}
        </ScrollView>

        <View style={{ paddingTop: space[3] }}>
          <Button
            title={selected ? `Connect ${selected.displayName}` : "Select a runtime"}
            onPress={connect}
            loading={connecting}
            disabled={!canConnect}
            left={<Ionicons name="link" size={18} color="#FFFFFF" />}
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
