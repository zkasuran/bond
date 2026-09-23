// The You tab: your Bond identity, your plan and your settings in one place. Identity is
// the did:key held on this device (or a lower-assurance web session), shown with its
// signature state so it reads as verifiable at a glance. Plan status comes from the "pro"
// entitlement, never a product id, so pricing can change without touching this screen.
import { type ComponentProps, useCallback, useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { Screen } from "@/components/ui/Screen";
import { Txt } from "@/components/ui/Text";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Avatar } from "@/components/ui/Avatar";
import { VerifiedBadge, Pill } from "@/components/ui/Badge";
import { useTokens } from "@/theme";
import { useBond } from "@/state/store";
import { useEntitlements } from "@/paywall/useEntitlements";
import { presentPaywall, restore } from "@/paywall/revenuecat";
import { FREE_MONTHLY_RUNS } from "@/paywall/plans";

type IoniconName = ComponentProps<typeof Ionicons>["name"];

export default function YouScreen() {
  const { c, space, radius } = useTokens();
  const router = useRouter();
  const identity = useBond((s) => s.identity);
  const assurance = useBond((s) => s.assurance);
  const monthlyRuns = useBond((s) => s.monthlyRuns);

  const isPro = useEntitlements((s) => s.isPro);
  const entitlementsReady = useEntitlements((s) => s.ready);
  const initEntitlements = useEntitlements((s) => s.init);
  const refreshEntitlements = useEntitlements((s) => s.refresh);

  const [upgrading, setUpgrading] = useState(false);
  const [restoring, setRestoring] = useState(false);

  // Nothing else configures RevenueCat, so settle the entitlement here. On web or in
  // Expo Go every underlying call is a no-op that resolves to the free tier, so this is
  // safe to run on mount.
  useEffect(() => {
    if (!entitlementsReady) void initEntitlements();
  }, [entitlementsReady, initEntitlements]);

  const onUpgrade = useCallback(async () => {
    setUpgrading(true);
    try {
      const outcome = await presentPaywall();
      // On web or Expo Go the native paywall cannot run, so fall back to the branded
      // in-app paywall that still shows the full comparison.
      if (outcome === "unavailable") router.push("/paywall");
    } finally {
      await refreshEntitlements();
      setUpgrading(false);
    }
  }, [refreshEntitlements, router]);

  const onRestore = useCallback(async () => {
    setRestoring(true);
    try {
      await restore();
    } finally {
      await refreshEntitlements();
      setRestoring(false);
    }
  }, [refreshEntitlements]);

  if (!identity) {
    return (
      <Screen>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <Txt variant="body" muted>
            Setting up your identity
          </Txt>
        </View>
      </Screen>
    );
  }

  const secure = assurance !== "web";
  const noteBg = secure ? c.verifiedSoft : c.surfaceAlt;
  const noteColor = secure ? c.verified : c.warning;
  const noteIcon: IoniconName = secure ? "lock-closed" : "globe-outline";
  const noteText = secure
    ? "Your signing key is held in this device's secure hardware and never leaves it."
    : "This is a web identity, so it is lower assurance. Keys live in browser storage with no secure enclave.";

  const runPct = Math.min(1, monthlyRuns / FREE_MONTHLY_RUNS);
  const runsLeft = Math.max(0, FREE_MONTHLY_RUNS - monthlyRuns);
  const meterColor = runPct >= 1 ? c.tampered : runPct >= 0.8 ? c.warning : c.brand;

  return (
    <Screen edges={["top"]}>
      <ScrollView
        contentContainerStyle={{ padding: space[4], paddingBottom: space[10], gap: space[6] }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ gap: space[1] }}>
          <Txt variant="display">You</Txt>
          <Txt variant="body" muted>
            Your identity, plan and settings.
          </Txt>
        </View>

        {/* Identity */}
        <View>
          <SectionLabel>Identity</SectionLabel>
          <Card style={{ gap: space[4] }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space[3] }}>
              <Avatar did={identity.did} name={identity.displayName} kind="human" size={64} />
              <View style={{ flex: 1, gap: space[2] }}>
                <Txt variant="heading" numberOfLines={1}>
                  {identity.displayName}
                </Txt>
                <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
                  <VerifiedBadge state="verified" />
                  <Pill label="You" tone="brand" />
                </View>
              </View>
            </View>

            <View style={{ gap: space[2] }}>
              <Txt variant="caption" faint style={{ letterSpacing: 0.6 }}>
                DECENTRALIZED IDENTIFIER
              </Txt>
              <View
                style={{
                  backgroundColor: c.surfaceSunken,
                  borderWidth: 1,
                  borderColor: c.border,
                  borderRadius: radius.md,
                  padding: space[3],
                }}
              >
                <Txt variant="mono" selectable color={c.textMuted}>
                  {identity.did}
                </Txt>
              </View>
            </View>

            <View
              style={{
                flexDirection: "row",
                gap: space[2],
                alignItems: "flex-start",
                backgroundColor: noteBg,
                borderRadius: radius.md,
                padding: space[3],
              }}
            >
              <Ionicons name={noteIcon} size={16} color={noteColor} style={{ marginTop: 1 }} />
              <Txt variant="caption" style={{ flex: 1, lineHeight: 18 }} color={noteColor}>
                {noteText}
              </Txt>
            </View>
          </Card>
        </View>

        {/* Wallet and security */}
        <View>
          <SectionLabel>Wallet and security</SectionLabel>
          <Card style={{ gap: space[3] }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space[3] }}>
              <View
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: radius.md,
                  backgroundColor: c.brandSoft,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Ionicons name="wallet-outline" size={22} color={c.brand} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Txt variant="heading">Solana wallet</Txt>
                <Txt variant="caption" muted>
                  Your identity key is also your Solana address. Connect a Seeker wallet to send USDC or swap in a room.
                </Txt>
              </View>
            </View>
            <Button
              title="Open wallet"
              variant="primary"
              onPress={() => router.push("/wallet")}
              left={<Ionicons name="wallet" size={16} color="#FFFFFF" />}
            />
            <Button
              title="Protection"
              variant="ghost"
              onPress={() => router.push("/protection")}
              left={<Ionicons name="shield-checkmark-outline" size={16} color={c.brand} />}
            />
            <Button
              title="Browse skills"
              variant="ghost"
              onPress={() => router.push("/market")}
              left={<Ionicons name="grid-outline" size={16} color={c.brand} />}
            />
          </Card>
        </View>

        {/* Bond Pro */}
        <View>
          <SectionLabel>Bond Pro</SectionLabel>
          <Card style={{ gap: space[4] }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space[3] }}>
              <View
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: radius.md,
                  backgroundColor: isPro ? c.brand : c.brandSoft,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Ionicons
                  name={isPro ? "star" : "star-outline"}
                  size={22}
                  color={isPro ? "#FFFFFF" : c.brand}
                />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Txt variant="heading">{isPro ? "Bond Pro" : "Free plan"}</Txt>
                <Txt variant="caption" muted>
                  {isPro
                    ? "Your whole team of agents in one verified space."
                    : "Upgrade to unlock your whole team of agents."}
                </Txt>
              </View>
              {isPro ? <Pill label="Active" tone="brand" /> : null}
            </View>

            {isPro ? (
              <View style={{ gap: space[1] }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Txt variant="callout">Agent runs this month</Txt>
                  <Txt variant="callout" color={c.brand}>
                    Unlimited
                  </Txt>
                </View>
                <Txt variant="caption" muted>
                  {monthlyRuns} runs used this month.
                </Txt>
              </View>
            ) : (
              <View style={{ gap: space[2] }}>
                <View
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                  }}
                >
                  <Txt variant="callout">Agent runs this month</Txt>
                  <Txt variant="callout" color={meterColor}>
                    {monthlyRuns} / {FREE_MONTHLY_RUNS}
                  </Txt>
                </View>
                <View
                  style={{
                    height: 8,
                    borderRadius: radius.pill,
                    backgroundColor: c.surfaceSunken,
                    overflow: "hidden",
                    flexDirection: "row",
                  }}
                >
                  <View style={{ flex: runPct, backgroundColor: meterColor }} />
                  <View style={{ flex: 1 - runPct }} />
                </View>
                <Txt variant="caption" muted>
                  {runsLeft > 0
                    ? `${runsLeft} runs left before you reach the free cap.`
                    : "You have reached the free cap. Upgrade for unlimited runs."}
                </Txt>
              </View>
            )}

            {isPro ? (
              <View style={{ gap: space[2] }}>
                <Txt variant="caption" muted>
                  Manage or cancel anytime from your app store account.
                </Txt>
                <Button
                  title="Restore purchases"
                  variant="ghost"
                  loading={restoring}
                  onPress={onRestore}
                />
              </View>
            ) : (
              <View style={{ gap: space[2] }}>
                <Button
                  title="Upgrade to Pro"
                  variant="primary"
                  loading={upgrading}
                  onPress={onUpgrade}
                  left={<Ionicons name="sparkles" size={16} color="#FFFFFF" />}
                />
                <Button
                  title="Restore purchases"
                  variant="ghost"
                  loading={restoring}
                  onPress={onRestore}
                />
              </View>
            )}
          </Card>
        </View>

        {/* Settings */}
        <View>
          <SectionLabel>Settings</SectionLabel>
          <Card>
            <SettingRow icon="person-outline" label="Display name" value={identity.displayName} />
            <SettingRow icon="finger-print" label="Signature" value="Ed25519" />
            <SettingRow
              icon={secure ? "lock-closed-outline" : "globe-outline"}
              label="Key storage"
              value={secure ? "Device secure hardware" : "Web session"}
              valueColor={secure ? c.verified : c.warning}
            />
            <SettingRow
              icon="star-outline"
              label="Plan"
              value={isPro ? "Bond Pro" : "Free"}
              valueColor={isPro ? c.brand : undefined}
              last
            />
          </Card>
        </View>

        <Txt variant="caption" faint style={{ textAlign: "center" }}>
          Bond. Humans and agents in one verified room.
        </Txt>
      </ScrollView>
    </Screen>
  );
}

function SectionLabel({ children }: { children: string }) {
  const { space } = useTokens();
  return (
    <Txt
      variant="caption"
      faint
      style={{
        letterSpacing: 1,
        textTransform: "uppercase",
        marginBottom: space[2],
        marginLeft: space[1],
      }}
    >
      {children}
    </Txt>
  );
}

function SettingRow({
  icon,
  label,
  value,
  valueColor,
  last,
}: {
  icon: IoniconName;
  label: string;
  value: string;
  valueColor?: string;
  last?: boolean;
}) {
  const { c, space } = useTokens();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space[3],
        paddingVertical: space[3],
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: c.border,
      }}
    >
      <View style={{ width: 24, alignItems: "center" }}>
        <Ionicons name={icon} size={18} color={c.textMuted} />
      </View>
      <Txt variant="body" style={{ flex: 1 }}>
        {label}
      </Txt>
      <Txt
        variant="callout"
        color={valueColor ?? c.textMuted}
        numberOfLines={1}
        style={{ maxWidth: "55%", textAlign: "right" }}
      >
        {value}
      </Txt>
    </View>
  );
}
