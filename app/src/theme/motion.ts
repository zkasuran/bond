// Bond motion tokens. One physics for the whole app, so a press, a new message and a
// sheet all feel like the same material. Springs are tuned to settle fast with a hint of
// overshoot; durations are short because a chat app is read, not watched.
import { Easing, FadeIn, FadeInDown, FadeInUp, ReduceMotion } from "react-native-reanimated";

export const spring = {
  /** Presses and toggles: quick and firm. */
  snappy: { damping: 18, stiffness: 320, mass: 0.6 },
  /** Elements arriving on screen. */
  gentle: { damping: 20, stiffness: 180, mass: 0.9 },
  /** Playful pops: badges, the send button, a confirmed receipt. */
  bouncy: { damping: 11, stiffness: 260, mass: 0.7 },
} as const;

export const duration = { fast: 140, base: 220, slow: 420, ambient: 1400 } as const;

export const ease = {
  out: Easing.bezier(0.16, 1, 0.3, 1),
  inOut: Easing.bezier(0.65, 0, 0.35, 1),
} as const;

/** Entering presets. Every one honours the system reduce-motion setting. */
export const enter = {
  /** A row arriving in a list, staggered by index. */
  row: (index = 0) =>
    FadeInDown.springify()
      .damping(spring.gentle.damping)
      .stiffness(spring.gentle.stiffness)
      .mass(spring.gentle.mass)
      .delay(Math.min(index, 8) * 45)
      .reduceMotion(ReduceMotion.System),
  /** A new message landing in a thread. */
  message: () =>
    FadeInUp.springify()
      .damping(spring.gentle.damping)
      .stiffness(spring.gentle.stiffness)
      .mass(spring.gentle.mass)
      .reduceMotion(ReduceMotion.System),
  /** A hero block, delayed in sequence. */
  hero: (step = 0) =>
    FadeInDown.duration(duration.slow)
      .easing(ease.out)
      .delay(80 + step * 90)
      .reduceMotion(ReduceMotion.System),
  fade: (delay = 0) => FadeIn.duration(duration.base).delay(delay).reduceMotion(ReduceMotion.System),
} as const;

/** Ambient loops (glow drift, breathing mark, pulse rings) play this many cycles and then
 *  settle. An idle screen must render zero frames, or a phone burns battery on decoration. */
export const AMBIENT_CYCLES = 3;
