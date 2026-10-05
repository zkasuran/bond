import { View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colorForDid, inkOnAccent, useTokens } from "@/theme";
import { Txt } from "./Text";

/** Humans get a circle, agents get a rounded square (the two shapes of the Bond mark), so
 *  the two read differently at a glance. Agents also carry a small spark. Color is derived
 *  from the did so an identity looks the same everywhere. */
export function Avatar({
  did,
  name,
  kind,
  size = 40,
  ring,
}: {
  did: string;
  name: string;
  kind: "human" | "agent";
  size?: number;
  /** Outline color, used when avatars overlap in a stack. */
  ring?: string;
}) {
  const { c } = useTokens();
  const bg = colorForDid(did, c);
  const initials = (name.trim().slice(0, 2) || "?").toUpperCase();
  const isAgent = kind === "agent";
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{
          width: size,
          height: size,
          borderRadius: isAgent ? size * 0.3 : size / 2,
          backgroundColor: bg,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: ring ? 2 : 0,
          borderColor: ring,
        }}
      >
        <Txt color={inkOnAccent(c)} style={{ fontSize: size * 0.36, lineHeight: size * 0.44, fontWeight: "700", letterSpacing: -0.3 }}>
          {initials}
        </Txt>
      </View>
      {isAgent && size >= 28 ? (
        <View
          style={{
            position: "absolute",
            right: -3,
            bottom: -3,
            width: size * 0.42,
            height: size * 0.42,
            borderRadius: size,
            backgroundColor: c.bg,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Ionicons name="sparkles" size={size * 0.26} color={c.agent} />
        </View>
      ) : null}
    </View>
  );
}
