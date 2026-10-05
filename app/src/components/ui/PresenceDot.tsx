import { PulseDot } from "@/components/motion/Ambient";

/** A presence dot. `live` gives a brief pulse on appearance; `busy` pulses while work is
 *  in flight (an agent composing a turn). Neither loops forever on an idle screen. */
export function PresenceDot({
  color,
  size = 8,
  live = false,
  busy = false,
}: {
  color?: string;
  size?: number;
  live?: boolean;
  busy?: boolean;
}) {
  return <PulseDot color={color} size={size} live={live} busy={busy} />;
}
