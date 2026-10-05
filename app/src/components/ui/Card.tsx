import { View, type ViewProps } from "react-native";
import { useTokens } from "@/theme";

export function Card({
  style,
  sunken,
  glow,
  ...rest
}: ViewProps & { sunken?: boolean; glow?: "brand" | "agent" }) {
  const { c, radius, space, scheme } = useTokens();
  return (
    <View
      {...rest}
      style={[
        {
          backgroundColor: sunken ? c.surfaceSunken : c.surface,
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: glow === "brand" ? c.brand + "55" : glow === "agent" ? c.agent + "55" : c.border,
          padding: space[4],
        },
        // A soft lift in light mode, a coloured halo when the card is the hero of a screen.
        glow
          ? { boxShadow: `0px 12px 36px -16px ${glow === "brand" ? c.glowBrand : c.glowAgent}` }
          : scheme === "light" && !sunken
            ? { boxShadow: "0px 1px 2px rgba(16,24,40,0.04), 0px 8px 24px -12px rgba(16,24,40,0.10)" }
            : null,
        style,
      ]}
    />
  );
}
