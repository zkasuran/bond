// Bond design tokens. One coherent visual system so the app reads as crafted (the
// Design Award bar). Built on top of the scaffold Colors/Spacing but richer: brand
// accent, agent vs human accents, and the verified/unsigned/tampered semantic colors
// the signing UI needs. Light and dark are both first-class.
import { Platform } from "react-native";
import { useColorScheme } from "@/hooks/use-color-scheme";

export const radius = { sm: 8, md: 12, lg: 18, xl: 26, pill: 999 } as const;

export const space = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  7: 32,
  8: 40,
  10: 56,
} as const;

export const font = Platform.select({
  ios: { sans: "system-ui", rounded: "ui-rounded", mono: "ui-monospace" },
  default: { sans: "normal", rounded: "normal", mono: "monospace" },
  web: { sans: "system-ui, sans-serif", rounded: "system-ui, sans-serif", mono: "monospace" },
}) as { sans: string; rounded: string; mono: string };

const light = {
  bg: "#FBFBFD",
  surface: "#FFFFFF",
  surfaceAlt: "#F2F3F7",
  surfaceSunken: "#ECEDF2",
  border: "#E3E4EA",
  borderStrong: "#D2D4DC",
  text: "#12131A",
  textMuted: "#5B5F6B",
  textFaint: "#8A8E99",
  brand: "#4F46E5",
  brandSoft: "#EEEEFC",
  onBrand: "#FFFFFF",
  agent: "#7C3AED",
  agentSoft: "#F3ECFE",
  human: "#0E7490",
  verified: "#15803D",
  verifiedSoft: "#E6F5EC",
  tampered: "#DC2626",
  tamperedSoft: "#FCEBEB",
  warning: "#B45309",
  online: "#22C55E",
} as const;

const dark: Record<keyof typeof light, string> = {
  bg: "#0B0C10",
  surface: "#15171E",
  surfaceAlt: "#1C1F27",
  surfaceSunken: "#23262F",
  border: "#2A2E38",
  borderStrong: "#3A3F4B",
  text: "#F5F6FA",
  textMuted: "#A6ABB8",
  textFaint: "#71778A",
  brand: "#8B8CF9",
  brandSoft: "#1E1F3A",
  onBrand: "#0B0C10",
  agent: "#B99CFB",
  agentSoft: "#241B3A",
  human: "#4DD0E1",
  verified: "#4ADE80",
  verifiedSoft: "#12291B",
  tampered: "#F87171",
  tamperedSoft: "#2E1616",
  warning: "#FBBF24",
  online: "#4ADE80",
};

export type Palette = typeof light;

export interface Tokens {
  scheme: "light" | "dark";
  c: Palette;
  space: typeof space;
  radius: typeof radius;
  font: { sans: string; rounded: string; mono: string };
}

export function useTokens(): Tokens {
  const scheme = useColorScheme();
  const resolved = scheme === "dark" ? "dark" : "light";
  return {
    scheme: resolved,
    c: resolved === "dark" ? (dark as Palette) : light,
    space,
    radius,
    font,
  };
}

/** Deterministic accent color for an identity, from a hash of its did. */
export function colorForDid(did: string, palette: Palette): string {
  const hues = [palette.brand, palette.agent, palette.human, "#DB2777", "#EA580C", "#0891B2"];
  let h = 0;
  for (let i = 0; i < did.length; i++) h = (h * 31 + did.charCodeAt(i)) >>> 0;
  return hues[h % hues.length];
}
