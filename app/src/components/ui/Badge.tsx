import { View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTokens } from "@/theme";
import type { VerifyResult } from "@/identity/sign";
import { Txt } from "./Text";

/** The three honest signature states. Unsigned is neutral, not a warning. */
export function VerifiedBadge({ state }: { state: VerifyResult }) {
  const { c, radius, space } = useTokens();
  const map = {
    verified: {
      label: "Verified",
      color: c.verified,
      soft: c.verifiedSoft,
      icon: "shield-checkmark" as const,
    },
    unsigned: {
      label: "Unsigned",
      color: c.textFaint,
      soft: c.surfaceAlt,
      icon: "ellipse-outline" as const,
    },
    tampered: {
      label: "Tampered",
      color: c.tampered,
      soft: c.tamperedSoft,
      icon: "warning" as const,
    },
  }[state];
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        backgroundColor: map.soft,
        paddingHorizontal: space[2],
        paddingVertical: 2,
        borderRadius: radius.pill,
      }}
    >
      <Ionicons name={map.icon} size={11} color={map.color} />
      <Txt variant="caption" color={map.color}>
        {map.label}
      </Txt>
    </View>
  );
}

export function Pill({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "brand" | "agent";
}) {
  const { c, radius, space } = useTokens();
  const bg = tone === "brand" ? c.brandSoft : tone === "agent" ? c.agentSoft : c.surfaceAlt;
  const fg = tone === "brand" ? c.brand : tone === "agent" ? c.agent : c.textMuted;
  return (
    <View
      style={{
        backgroundColor: bg,
        paddingHorizontal: space[2],
        paddingVertical: 3,
        borderRadius: radius.pill,
        alignSelf: "flex-start",
      }}
    >
      <Txt variant="caption" color={fg}>
        {label}
      </Txt>
    </View>
  );
}
