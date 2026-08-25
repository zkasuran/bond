import { Text as RNText, type TextProps, type TextStyle } from "react-native";
import { useTokens } from "@/theme";

export type TextVariant =
  | "display"
  | "title"
  | "heading"
  | "body"
  | "callout"
  | "caption"
  | "mono";

const SIZES: Record<TextVariant, TextStyle> = {
  display: { fontSize: 30, lineHeight: 36, fontWeight: "800", letterSpacing: -0.5 },
  title: { fontSize: 24, lineHeight: 30, fontWeight: "700", letterSpacing: -0.3 },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: "700" },
  body: { fontSize: 16, lineHeight: 23, fontWeight: "400" },
  callout: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
  caption: { fontSize: 13, lineHeight: 17, fontWeight: "500" },
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
  const { c, font } = useTokens();
  const resolved = color ?? (faint ? c.textFaint : muted ? c.textMuted : c.text);
  const family = variant === "mono" ? font.mono : font.sans;
  return (
    <RNText {...rest} style={[SIZES[variant], { color: resolved, fontFamily: family }, style]} />
  );
}
