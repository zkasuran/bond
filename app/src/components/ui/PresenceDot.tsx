import { View } from "react-native";
import { useTokens } from "@/theme";

export function PresenceDot({ color, size = 8 }: { color?: string; size?: number }) {
  const { c } = useTokens();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color ?? c.online,
      }}
    />
  );
}
