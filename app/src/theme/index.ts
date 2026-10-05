// Bond design tokens. One system shared with the site and the README: Solana mint for
// action and trust, violet for agents, cyan for humans, on a deep ink ground. Light and
// dark are both first-class. Motion tokens live in `./motion` so every screen moves with
// the same physics.
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

/** Geist, bundled in `assets/fonts` and loaded in the root layout. Each weight is its own
 *  family because Android does not synthesise weights for a custom font. */
export const families = {
  regular: "Geist-Regular",
  medium: "Geist-Medium",
  semibold: "Geist-SemiBold",
  bold: "Geist-Bold",
  black: "Geist-Black",
  mono: "GeistMono-Regular",
  monoMedium: "GeistMono-Medium",
} as const;

export const font = Platform.select({
  web: {
    sans: `${families.regular}, system-ui, sans-serif`,
    rounded: `${families.regular}, system-ui, sans-serif`,
    mono: `${families.mono}, ui-monospace, monospace`,
  },
  default: { sans: families.regular, rounded: families.regular, mono: families.mono },
}) as { sans: string; rounded: string; mono: string };

/** Pick the Geist family for a CSS-style weight. */
export function familyForWeight(weight: string | number | undefined, mono = false): string {
  const w = typeof weight === "number" ? weight : weight === "bold" ? 700 : Number(weight) || 400;
  if (mono) return w >= 500 ? families.monoMedium : families.mono;
  if (w >= 800) return families.black;
  if (w >= 700) return families.bold;
  if (w >= 600) return families.semibold;
  if (w >= 500) return families.medium;
  return families.regular;
}

const light = {
  bg: "#F6F7F9",
  surface: "#FFFFFF",
  surfaceAlt: "#F0F2F5",
  surfaceSunken: "#E8EBF0",
  border: "#E2E6EC",
  borderStrong: "#CDD3DC",
  text: "#0B0E13",
  textMuted: "#535C6B",
  textFaint: "#8790A0",
  brand: "#07A26C",
  brandSoft: "#E3F7EE",
  onBrand: "#FFFFFF",
  agent: "#7A3CF0",
  agentSoft: "#F1EAFE",
  human: "#0A8EA8",
  verified: "#078A5C",
  verifiedSoft: "#E3F7EE",
  tampered: "#E0294A",
  tamperedSoft: "#FDE8EC",
  warning: "#B86E00",
  online: "#12C784",
  glowBrand: "rgba(7,162,108,0.16)",
  glowAgent: "rgba(122,60,240,0.14)",
  scrim: "rgba(11,14,19,0.42)",
} as const;

const dark: Record<keyof typeof light, string> = {
  bg: "#07090C",
  surface: "#0F1318",
  surfaceAlt: "#151A21",
  surfaceSunken: "#1B212A",
  border: "#1E252F",
  borderStrong: "#2D3644",
  text: "#F2F5F9",
  textMuted: "#9AA5B5",
  textFaint: "#667186",
  brand: "#14F195",
  brandSoft: "#0B2A1E",
  onBrand: "#03140C",
  agent: "#B48CFF",
  agentSoft: "#1E1636",
  human: "#5CE1E6",
  verified: "#3BF0A6",
  verifiedSoft: "#0C2A1F",
  tampered: "#FF5C7A",
  tamperedSoft: "#2E1219",
  warning: "#FFB547",
  online: "#14F195",
  glowBrand: "rgba(20,241,149,0.20)",
  glowAgent: "rgba(153,69,255,0.24)",
  scrim: "rgba(0,0,0,0.6)",
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

const isDark = (palette: Palette) => palette.bg === dark.bg;

/** Deterministic accent color for an identity, from a hash of its did. Dark mode uses
 *  light hues (read with ink initials), light mode deep ones (read with white). */
export function colorForDid(did: string, palette: Palette): string {
  const hues = isDark(palette)
    ? [palette.human, palette.agent, palette.brand, "#F9A8D4", "#FDBA74", "#7DD3FC"]
    : [palette.human, palette.agent, palette.brand, "#DB2777", "#EA580C", "#0284C7"];
  let h = 0;
  for (let i = 0; i < did.length; i++) h = (h * 31 + did.charCodeAt(i)) >>> 0;
  return hues[h % hues.length];
}

/** The ink that sits on an identity color. */
export function inkOnAccent(palette: Palette): string {
  return isDark(palette) ? "#05080B" : "#FFFFFF";
}
