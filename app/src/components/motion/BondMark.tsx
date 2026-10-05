// The Bond mark, drawn natively: a human circle bonded to an agent square, the overlap
// lit where they meet. Same geometry as docs/assets/brand/mark.svg. With `animate` the two
// members slide in from either side and bond on a spring, then the lens lights up; with
// `rings` soft signal rings radiate from the bond, the mark's idle "alive" state.
import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { spring } from "@/theme/motion";

export const MARK = { human: "#14F195", agent: "#9945FF", lens: "#F4FFF9" } as const;

const OVERLAP = 150 / 392;
const RADIUS = 118 / 392;

export function BondMark({
  size = 64,
  animate = false,
  rings = false,
  breathe = false,
  delay = 0,
}: {
  /** Height of the mark; the width is about 1.62x. */
  size?: number;
  animate?: boolean;
  rings?: boolean;
  breathe?: boolean;
  delay?: number;
}) {
  const reduced = useReducedMotion();
  const o = size * OVERLAP;
  const width = size * 2 - o;
  const run = animate && !reduced;

  const join = useSharedValue(run ? 0 : 1);
  const lens = useSharedValue(run ? 0 : 1);
  const pulse = useSharedValue(1);

  useEffect(() => {
    if (!run) return;
    join.set(withDelay(delay, withSpring(1, { ...spring.bouncy, reduceMotion: ReduceMotion.System })));
    lens.set(withDelay(delay + 380, withTiming(1, { duration: 360, easing: Easing.out(Easing.cubic) })));
  }, [run, delay, join, lens]);

  useEffect(() => {
    if (!breathe || reduced) return;
    pulse.set(
      withDelay(
        delay + 900,
        withRepeat(
          withSequence(
            withTiming(1.035, { duration: 1600, easing: Easing.inOut(Easing.sin) }),
            withTiming(1, { duration: 1600, easing: Easing.inOut(Easing.sin) }),
          ),
          -1,
        ),
      ),
    );
  }, [breathe, reduced, delay, pulse]);

  const gap = size * 0.55;
  const humanStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, join.get() * 1.6),
    transform: [{ translateX: (1 - join.get()) * -gap }, { rotate: `${(1 - join.get()) * -18}deg` }],
  }));
  const agentStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, join.get() * 1.6),
    transform: [{ translateX: (1 - join.get()) * gap }, { rotate: `${(1 - join.get()) * 18}deg` }],
  }));
  const lensStyle = useAnimatedStyle(() => ({ opacity: lens.get() }));
  const wholeStyle = useAnimatedStyle(() => ({ transform: [{ scale: pulse.get() }] }));

  return (
    <View style={{ width, height: size, alignItems: "center", justifyContent: "center" }}>
      {rings && !reduced ? (
        <>
          <Ring size={size} width={width} delay={delay + 700} />
          <Ring size={size} width={width} delay={delay + 1900} />
        </>
      ) : null}
      <Animated.View style={[{ width, height: size }, wholeStyle]}>
        <Animated.View
          style={[
            { position: "absolute", left: 0, top: 0, width: size, height: size, borderRadius: size / 2, backgroundColor: MARK.human },
            humanStyle,
          ]}
        />
        <Animated.View
          style={[
            {
              position: "absolute",
              left: size - o,
              top: 0,
              width: size,
              height: size,
              borderRadius: size * RADIUS,
              backgroundColor: MARK.agent,
              overflow: "hidden",
            },
            agentStyle,
          ]}
        >
          <Animated.View
            style={[
              { position: "absolute", left: -(size - o), top: 0, width: size, height: size, borderRadius: size / 2, backgroundColor: MARK.lens },
              lensStyle,
            ]}
          />
        </Animated.View>
      </Animated.View>
    </View>
  );
}

function Ring({ size, width, delay }: { size: number; width: number; delay: number }) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.set(withDelay(delay, withRepeat(withTiming(1, { duration: 2400, easing: Easing.out(Easing.quad) }), -1)));
  }, [delay, t]);
  return <RingView t={t} size={size} width={width} />;
}

function RingView({ t, size, width }: { t: SharedValue<number>; size: number; width: number }) {
  const d = width * 1.05;
  const style = useAnimatedStyle(() => ({
    opacity: (1 - t.get()) * 0.45,
    transform: [{ scale: 0.75 + t.get() * 0.6 }],
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: "absolute",
          width: d,
          height: d,
          top: (size - d) / 2,
          left: (width - d) / 2,
          borderRadius: d / 2,
          borderWidth: 1.5,
          borderColor: MARK.human,
        },
        style,
      ]}
    />
  );
}
