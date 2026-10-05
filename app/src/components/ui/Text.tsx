import { Platform, StyleSheet, Text as RNText, type TextProps, type TextStyle } from "react-native";
import { familyForWeight, useTokens } from "@/theme";

export type TextVariant =
  | "hero"
  | "display"
  | "title"
  | "heading"
  | "body"
  | "callout"
  | "caption"
  | "label"
  | "mono";

// A tight, editorial scale. Large sizes carry negative tracking the way Geist is drawn to
// be set; the uppercase label is the small mono-feel eyebrow used across the app.
const SIZES: Record<TextVariant, TextStyle> = {
  hero: { fontSize: 40, lineHeight: 42, fontWeight: "700", letterSpacing: -1.6 },
  display: { fontSize: 30, lineHeight: 34, fontWeight: "700", letterSpacing: -1 },
  title: { fontSize: 23, lineHeight: 28, fontWeight: "700", letterSpacing: -0.5 },
  heading: { fontSize: 17, lineHeight: 22, fontWeight: "600", letterSpacing: -0.2 },
  body: { fontSize: 16, lineHeight: 23, fontWeight: "400" },
  callout: { fontSize: 15, lineHeight: 20, fontWeight: "600", letterSpacing: -0.1 },
  caption: { fontSize: 13, lineHeight: 17, fontWeight: "500" },
  label: { fontSize: 11, lineHeight: 14, fontWeight: "600", letterSpacing: 1.2, textTransform: "uppercase" },
  mono: { fontSize: 13, lineHeight: 18, fontWeight: "400" },
};

export function Txt({
  variant = "body",
  color,
  muted,
  faint,
  style,
  ...rest
}: TextProps & {
  variant?: TextVariant;
  color?: string;
  muted?: boolean;
  faint?: boolean;
}) {
  const { c } = useTokens();
  const resolved = color ?? (faint ? c.textFaint : muted ? c.textMuted : c.text);
  // Resolve the family from the final weight (variant plus any override), so a bold span
  // inside a body line gets Geist Bold on Android instead of a faux-bold Regular.
  const flat = StyleSheet.flatten([SIZES[variant], style]) ?? {};
  const family = flat.fontFamily ?? familyForWeight(flat.fontWeight, variant === "mono");
  // Native: the family already is the weight, so weight resets to normal (no faux bold).
  // Web: keep the weight and a system fallback so text reads right while fonts load.
  const resolvedFont: TextStyle =
    Platform.OS === "web"
      ? { fontFamily: `${family}, ${variant === "mono" ? "ui-monospace, monospace" : "system-ui, sans-serif"}` }
      : { fontFamily: family, fontWeight: "normal" };
  return <RNText {...rest} style={[SIZES[variant], { color: resolved }, style, resolvedFont]} />;
}
