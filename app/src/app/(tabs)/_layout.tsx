import { Tabs } from "expo-router";
import { useTokens } from "@/theme";
import { BondTabBar } from "@/components/BondTabBar";

export default function TabsLayout() {
  const { c } = useTokens();
  return (
    <Tabs
      tabBar={(props) => <BondTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: c.bg },
        animation: "shift",
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Rooms" }} />
      <Tabs.Screen name="agents" options={{ title: "Agents" }} />
      <Tabs.Screen name="you" options={{ title: "You" }} />
    </Tabs>
  );
}
