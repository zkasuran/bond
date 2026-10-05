// Bond's tab bar. A docked bar with one mint pill that glides to the active tab on a
// spring, the active icon filling in as it arrives. Docked (not floating) so screens never
// need to pad for it. Long-press and accessibility state match the stock bar.
import { useEffect, useState, type ComponentProps } from "react";
import { Platform, View, type LayoutChangeEvent } from "react-native";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useTokens } from "@/theme";
import { spring } from "@/theme/motion";
import { PressableScale } from "@/components/motion/PressableScale";
import { Txt } from "@/components/ui/Text";

type TabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>["tabBar"]>>[0];
type IconName = ComponentProps<typeof Ionicons>["name"];

export const TAB_ICONS: Record<string, { on: IconName; off: IconName }> = {
  index: { on: "chatbubbles", off: "chatbubbles-outline" },
  agents: { on: "sparkles", off: "sparkles-outline" },
  you: { on: "person-circle", off: "person-circle-outline" },
};

export function BondTabBar({ state, descriptors, navigation, insets }: TabBarProps) {
  const { c, space, radius } = useTokens();
  const [width, setWidth] = useState(0);
  const count = state.routes.length;
  const slot = width / Math.max(count, 1);
  const x = useSharedValue(0);

  useEffect(() => {
    if (slot > 0) x.set(withSpring(state.index * slot, spring.gentle));
  }, [state.index, slot, x]);

  const pill = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() }] }));
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  return (
    <View
      style={{
        backgroundColor: c.surface,
        borderTopWidth: 1,
        borderTopColor: c.border,
        paddingTop: space[2],
        paddingBottom: Math.max(insets.bottom, space[2]),
        paddingHorizontal: space[3],
      }}
    >
      <View onLayout={onLayout} style={{ flexDirection: "row", height: 54 }}>
        {width > 0 ? (
          <Animated.View
            pointerEvents="none"
            style={[
              { position: "absolute", top: 3, bottom: 3, left: 0, width: slot, alignItems: "center" },
              pill,
            ]}
          >
            <View
              style={{
                width: Math.min(slot - space[2], 112),
                height: "100%",
                borderRadius: radius.lg,
                backgroundColor: c.brandSoft,
                borderWidth: 1,
                borderColor: c.brand + "40",
              }}
            />
          </Animated.View>
        ) : null}
        {state.routes.map((route, i) => {
          const { options } = descriptors[route.key]!;
          const focused = state.index === i;
          const label = typeof options.title === "string" ? options.title : route.name;
          const icons = TAB_ICONS[route.name] ?? { on: "ellipse", off: "ellipse-outline" };
          const onPress = () => {
            const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
            if (!focused && !event.defaultPrevented) {
              if (Platform.OS !== "web") void Haptics.selectionAsync().catch(() => {});
              navigation.navigate(route.name, route.params);
            }
          };
          return (
            <PressableScale
              key={route.key}
              onPress={onPress}
              onLongPress={() => navigation.emit({ type: "tabLongPress", target: route.key })}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={options.tabBarAccessibilityLabel ?? label}
              testID={`tab-${route.name}`}
              pressedScale={0.92}
              style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 3 }}
            >
              <Ionicons name={focused ? icons.on : icons.off} size={21} color={focused ? c.brand : c.textFaint} />
              <Txt
                variant="caption"
                color={focused ? c.text : c.textFaint}
                style={{ fontSize: 11, lineHeight: 13, fontWeight: focused ? "600" : "500" }}
              >
                {label}
              </Txt>
            </PressableScale>
          );
        })}
      </View>
    </View>
  );
}
