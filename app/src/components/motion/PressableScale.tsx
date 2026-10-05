// A Pressable that physically gives under the finger: a spring scale-down on press-in
// and a bouncy settle on release. The shared press feel for buttons, cards and chips.
import { useState } from "react";
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { spring } from "@/theme/motion";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export type PressableScaleProps = Omit<PressableProps, "style"> & {
  style?: StyleProp<ViewStyle> | ((state: { pressed: boolean }) => StyleProp<ViewStyle>);
  /** How far the element sinks while held. */
  pressedScale?: number;
};

export function PressableScale({
  style,
  pressedScale = 0.965,
  onPressIn,
  onPressOut,
  disabled,
  ...rest
}: PressableScaleProps) {
  const scale = useSharedValue(1);
  // Reanimated wants a plain style, so a function style is resolved from local state.
  const [pressed, setPressed] = useState(false);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
  const resolved = typeof style === "function" ? style({ pressed }) : style;
  return (
    <AnimatedPressable
      disabled={disabled}
      onPressIn={(e) => {
        if (!disabled) {
          scale.set(withSpring(pressedScale, spring.snappy));
          if (typeof style === "function") setPressed(true);
        }
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        scale.set(withSpring(1, spring.bouncy));
        if (typeof style === "function") setPressed(false);
        onPressOut?.(e);
      }}
      style={[resolved, animated]}
      {...rest}
    />
  );
}
