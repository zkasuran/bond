import { View, type ViewProps } from "react-native";
import { useTokens } from "@/theme";

export function Card({
  style,
  sunken,
  ...rest
}: ViewProps & { sunken?: boolean }) {
  const { c, radius, space } = useTokens();
  return (
    <View
      {...rest}
      style={[
        {
          backgroundColor: sunken ? c.surfaceSunken : c.surface,
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: c.border,
          padding: space[4],
        },
        style,
      ]}
    />
  );
}
