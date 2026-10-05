import { PulseDot } from "@/components/motion/Ambient";

/** A presence dot. Live presences breathe, so an online agent reads as awake. */
export function PresenceDot({ color, size = 8, live = false }: { color?: string; size?: number; live?: boolean }) {
  return <PulseDot color={color} size={size} live={live} />;
}
