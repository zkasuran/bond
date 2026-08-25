import type { ReactNode } from "react";
import { View, type ViewStyle } from "react-native";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";
import { useTokens } from "@/theme";

export function Screen({
  children,
  style,
  edges = ["top", "bottom"],
  padded,
}: {
  children: ReactNode;
  style?: ViewStyle;
  edges?: readonly Edge[];
  padded?: boolean;
}) {
  const { c, space } = useTokens();
  return (
    <SafeAreaView edges={edges} style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={[{ flex: 1 }, padded ? { padding: space[4] } : null, style]}>{children}</View>
    </SafeAreaView>
  );
}
