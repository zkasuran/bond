import type { ReactNode } from "react";
import { ActivityIndicator, Platform, type ViewStyle } from "react-native";
import * as Haptics from "expo-haptics";
import { useTokens } from "@/theme";
import { PressableScale } from "@/components/motion/PressableScale";
import { Txt } from "./Text";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  title,
  onPress,
  variant = "primary",
  disabled,
  loading,
  style,
  left,
  testID,
}: {
  title: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
  left?: ReactNode;
  testID?: string;
}) {
  const { c, radius, space } = useTokens();
  const bg = { primary: c.brand, danger: c.tampered, secondary: c.surfaceAlt, ghost: "transparent" }[
    variant
  ];
  const fg =
    variant === "primary"
      ? c.onBrand
      : variant === "danger"
        ? "#FFFFFF"
        : variant === "ghost"
          ? c.brand
          : c.text;
  const glow =
    variant === "primary" && !disabled
      ? { boxShadow: `0px 10px 26px -8px ${c.glowBrand}` }
      : variant === "danger" && !disabled
        ? { boxShadow: `0px 10px 26px -12px ${c.tampered}66` }
        : null;
  const handle = () => {
    if (disabled || loading) return;
    if (Platform.OS !== "web") void Haptics.selectionAsync().catch(() => {});
    onPress?.();
  };
  return (
    <PressableScale
      testID={testID}
      onPress={handle}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!(disabled || loading), busy: !!loading }}
      style={({ pressed }) => [
        {
          backgroundColor: bg,
          borderColor: variant === "secondary" ? c.border : "transparent",
          borderWidth: variant === "secondary" ? 1 : 0,
          borderRadius: radius.lg,
          minHeight: 50,
          paddingVertical: space[3],
          paddingHorizontal: space[5],
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: space[2],
          opacity: disabled ? 0.45 : pressed ? 0.92 : 1,
        },
        glow,
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={fg} /> : left}
      <Txt variant="callout" color={fg}>
        {title}
      </Txt>
    </PressableScale>
  );
}
