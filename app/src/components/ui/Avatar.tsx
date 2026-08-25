import { View } from "react-native";
import { colorForDid, useTokens } from "@/theme";
import { Txt } from "./Text";

/** Humans get a circle, agents get a rounded square, so the two read differently at a
 *  glance. Color is derived from the did so an identity looks the same everywhere. */
export function Avatar({
  did,
  name,
  kind,
  size = 40,
}: {
  did: string;
  name: string;
  kind: "human" | "agent";
  size?: number;
}) {
  const { c } = useTokens();
  const bg = colorForDid(did, c);
  const initials = (name.trim().slice(0, 2) || "?").toUpperCase();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: kind === "agent" ? size * 0.3 : size / 2,
        backgroundColor: bg,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Txt color="#FFFFFF" style={{ fontSize: size * 0.38, fontWeight: "700" }}>
        {initials}
      </Txt>
    </View>
  );
}
