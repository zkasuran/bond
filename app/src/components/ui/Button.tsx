import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  type ViewStyle,
} from "react-native";
import * as Haptics from "expo-haptics";
import { useTokens } from "@/theme";
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
}: {
  title: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
  left?: ReactNode;
}) {
  const { c, radius, space } = useTokens();
  const bg = { primary: c.brand, danger: c.tampered, secondary: c.surfaceAlt, ghost: "transparent" }[
    variant
  ];
  const fg =
    variant === "primary" || variant === "danger"
      ? "#FFFFFF"
      : variant === "ghost"
        ? c.brand
        : c.text;
  const handle = () => {
    if (disabled || loading) return;
    if (Platform.OS !== "web") void Haptics.selectionAsync().catch(() => {});
    onPress?.();
  };
  return (
    <Pressable
      onPress={handle}
      disabled={disabled || loading}
      style={({ pressed }) => [
        {
          backgroundColor: bg,
          borderColor: variant === "secondary" ? c.border : "transparent",
          borderWidth: variant === "secondary" ? 1 : 0,
          borderRadius: radius.md,
          paddingVertical: space[3] + 2,
          paddingHorizontal: space[5],
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: space[2],
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={fg} /> : left}
      <Txt variant="callout" color={fg}>
        {title}
      </Txt>
    </Pressable>
  );
}
