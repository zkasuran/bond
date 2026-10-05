// Small ambient motion pieces: the agent typing dots, a live presence pulse, the soft
// drifting brand glow behind hero screens and a Reveal wrapper for staggered entrances.
// All of them stand still when the system asks for reduced motion.
import { useEffect, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { Image } from "expo-image";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { useTokens } from "@/theme";
import { enter } from "@/theme/motion";

/** Three dots that rise and fall in sequence: an agent composing its turn. */
export function TypingDots({ color, size = 6 }: { color?: string; size?: number }) {
  const { c } = useTokens();
  const tint = color ?? c.agent;
  return (
    <View
      accessibilityLabel="Agent is thinking"
      style={{ flexDirection: "row", alignItems: "center", gap: size * 0.7, height: size * 3.4 }}
    >
      {[0, 1, 2].map((i) => (
        <Dot key={i} index={i} color={tint} size={size} />
      ))}
    </View>
  );
}

function Dot({ index, color, size }: { index: number; color: string; size: number }) {
  const reduced = useReducedMotion();
  const t = useSharedValue(0);
  useEffect(() => {
    if (reduced) return;
    t.set(
      withDelay(
        index * 140,
        withRepeat(
          withSequence(
            withTiming(1, { duration: 320, easing: Easing.out(Easing.quad) }),
            withTiming(0, { duration: 320, easing: Easing.in(Easing.quad) }),
            withTiming(0, { duration: 280 }),
          ),
          -1,
        ),
      ),
    );
  }, [index, reduced, t]);
  const style = useAnimatedStyle(() => ({
    opacity: 0.35 + t.get() * 0.65,
    transform: [{ translateY: -t.get() * size * 0.7 }],
  }));
  return (
    <Animated.View
      style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }, style]}
    />
  );
}

/** A presence dot with a soft ring breathing out of it. */
export function PulseDot({ color, size = 8, live = true }: { color?: string; size?: number; live?: boolean }) {
  const { c } = useTokens();
  const reduced = useReducedMotion();
  const tint = color ?? c.online;
  const t = useSharedValue(0);
  useEffect(() => {
    if (!live || reduced) return;
    t.set(withRepeat(withTiming(1, { duration: 1800, easing: Easing.out(Easing.quad) }), -1));
  }, [live, reduced, t]);
  const ring = useAnimatedStyle(() => ({
    opacity: (1 - t.get()) * 0.55,
    transform: [{ scale: 1 + t.get() * 1.8 }],
  }));
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      {live && !reduced ? (
        <Animated.View
          pointerEvents="none"
          style={[
            { position: "absolute", width: size, height: size, borderRadius: size / 2, backgroundColor: tint },
            ring,
          ]}
        />
      ) : null}
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: tint }} />
    </View>
  );
}

const GLOW_MINT = require("../../../assets/images/glow-mint.png");
const GLOW_VIOLET = require("../../../assets/images/glow-violet.png");

/** Two soft brand glows drifting slowly behind a screen. Purely decorative. */
export function AmbientGlow({
  intensity = 1,
  style,
}: {
  intensity?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const { scheme } = useTokens();
  const reduced = useReducedMotion();
  const t = useSharedValue(0);
  useEffect(() => {
    if (reduced) return;
    t.set(
      withRepeat(
        withSequence(
          withTiming(1, { duration: 7000, easing: Easing.inOut(Easing.sin) }),
          withTiming(0, { duration: 7000, easing: Easing.inOut(Easing.sin) }),
        ),
        -1,
      ),
    );
  }, [reduced, t]);
  const base = (scheme === "dark" ? 0.32 : 0.16) * intensity;
  const a = useAnimatedStyle(() => ({
    transform: [{ translateX: -40 + t.get() * 70 }, { translateY: t.get() * 40 }, { scale: 1 + t.get() * 0.15 }],
  }));
  const b = useAnimatedStyle(() => ({
    transform: [{ translateX: 30 - t.get() * 60 }, { translateY: -t.get() * 50 }, { scale: 1.1 - t.get() * 0.12 }],
  }));
  return (
    <View pointerEvents="none" style={[{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, overflow: "hidden" }, style]}>
      <Animated.View style={[{ position: "absolute", top: -140, left: -160, width: 460, height: 460, opacity: base }, a]}>
        <Image source={GLOW_MINT} style={{ width: "100%", height: "100%" }} contentFit="contain" />
      </Animated.View>
      <Animated.View style={[{ position: "absolute", bottom: -120, right: -180, width: 520, height: 520, opacity: base * 1.1 }, b]}>
        <Image source={GLOW_VIOLET} style={{ width: "100%", height: "100%" }} contentFit="contain" />
      </Animated.View>
    </View>
  );
}

/** Stagger children in as they mount. `index` sets their place in the sequence. */
export function Reveal({
  index = 0,
  children,
  style,
}: {
  index?: number;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Animated.View entering={enter.row(index)} style={style}>
      {children}
    </Animated.View>
  );
}
