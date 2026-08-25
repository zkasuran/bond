// The Bond Pro paywall, presented as a modal. It states the free-vs-Pro split straight
// from plans.ts so the numbers on screen never drift from the gate that enforces them,
// then hands off to the RevenueCat prebuilt paywall for the purchase itself. On web or
// Expo Go the native paywall cannot run, so the primary button degrades without crashing.
import { useCallback, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { Screen } from "@/components/ui/Screen";
import { Txt } from "@/components/ui/Text";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Badge";
import { useTokens } from "@/theme";
import { presentPaywall } from "@/paywall/revenuecat";
import { useEntitlements } from "@/paywall/useEntitlements";
import { FREE_BRIDGES, FREE_MONTHLY_RUNS, FREE_ROOMS } from "@/paywall/plans";

interface Feature {
  label: string;
  free: string;
  pro: string;
}

const FEATURES: Feature[] = [
  { label: "Rooms", free: `${FREE_ROOMS}`, pro: "Unlimited" },
  { label: "Connected bridges", free: `${FREE_BRIDGES} at a time`, pro: "Every bridge at once" },
  { label: "Agent runs each month", free: `${FREE_MONTHLY_RUNS}`, pro: "Unlimited" },
  { label: "Agents per room", free: "One", pro: "Your whole team" },
  { label: "Verified signing", free: "Included", pro: "Included" },
];

export default function PaywallScreen() {
  const { c, space, radius } = useTokens();
  const router = useRouter();
  const refreshEntitlements = useEntitlements((s) => s.refresh);
  const [starting, setStarting] = useState(false);

  const close = useCallback(() => router.back(), [router]);

  const onStart = useCallback(async () => {
    setStarting(true);
    try {
      const outcome = await presentPaywall();
      await refreshEntitlements();
      if (outcome === "purchased" || outcome === "restored") close();
    } finally {
      setStarting(false);
    }
  }, [refreshEntitlements, close]);

  return (
    <Screen edges={["top", "bottom"]}>
      <View style={{ flex: 1 }}>
        <View
          style={{
            flexDirection: "row",
            justifyContent: "flex-end",
            paddingHorizontal: space[4],
            paddingTop: space[2],
          }}
        >
          <Pressable
            onPress={close}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={{
              width: 36,
              height: 36,
              borderRadius: radius.pill,
              backgroundColor: c.surfaceAlt,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ionicons name="close" size={20} color={c.textMuted} />
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: space[4],
            paddingBottom: space[6],
            gap: space[6],
          }}
          showsVerticalScrollIndicator={false}
        >
          <View style={{ alignItems: "center", gap: space[3], paddingTop: space[2] }}>
            <View
              style={{
                width: 72,
                height: 72,
                borderRadius: radius.xl,
                backgroundColor: c.brandSoft,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Ionicons name="sparkles" size={34} color={c.brand} />
            </View>
            <Pill label="Bond Pro" tone="brand" />
            <Txt variant="title" style={{ textAlign: "center" }}>
              Unlock your whole team of agents in one verified space.
            </Txt>
            <Txt variant="body" muted style={{ textAlign: "center" }}>
              Bring every agent you run into a single room where humans and agents share one
              signed, verifiable thread.
            </Txt>
          </View>

          <View
            style={{
              borderWidth: 1,
              borderColor: c.border,
              borderRadius: radius.lg,
              overflow: "hidden",
              backgroundColor: c.surface,
            }}
          >
            <View
              style={{
                flexDirection: "row",
                backgroundColor: c.surfaceAlt,
                paddingVertical: space[3],
                paddingHorizontal: space[4],
              }}
            >
              <Txt variant="caption" faint style={{ flex: 1.4 }}>
                WHAT YOU GET
              </Txt>
              <Txt variant="caption" faint style={{ flex: 1, textAlign: "center" }}>
                FREE
              </Txt>
              <Txt variant="caption" color={c.brand} style={{ flex: 1, textAlign: "center" }}>
                PRO
              </Txt>
            </View>
            {FEATURES.map((f, i) => (
              <View
                key={f.label}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingVertical: space[3],
                  paddingHorizontal: space[4],
                  borderTopWidth: i === 0 ? 0 : 1,
                  borderTopColor: c.border,
                }}
              >
                <Txt variant="callout" style={{ flex: 1.4 }}>
                  {f.label}
                </Txt>
                <Txt variant="caption" muted style={{ flex: 1, textAlign: "center" }}>
                  {f.free}
                </Txt>
                <Txt
                  variant="caption"
                  color={c.brand}
                  style={{ flex: 1, textAlign: "center", fontWeight: "700" }}
                >
                  {f.pro}
                </Txt>
              </View>
            ))}
          </View>

          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: space[2],
            }}
          >
            <Ionicons name="shield-checkmark" size={16} color={c.verified} />
            <Txt variant="caption" muted>
              7 days free. Cancel anytime before it ends.
            </Txt>
          </View>
        </ScrollView>
        <View
          style={{
            paddingHorizontal: space[4],
            paddingTop: space[3],
            paddingBottom: space[3],
            gap: space[2],
            borderTopWidth: 1,
            borderTopColor: c.border,
            backgroundColor: c.bg,
          }}
        >
          <Button
            title="Start 7-day free trial"
            variant="primary"
            loading={starting}
            onPress={onStart}
            left={<Ionicons name="sparkles" size={16} color="#FFFFFF" />}
          />
          <Button title="Not now" variant="ghost" onPress={close} />
        </View>
      </View>
    </Screen>
  );
}
