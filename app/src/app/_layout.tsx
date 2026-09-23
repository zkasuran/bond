// Polyfill Web Crypto for on-device signing. Must run before any code that signs.
import "react-native-get-random-values";
import "@/global.css";

import { useEffect } from "react";
import { View } from "react-native";
import { Stack, useRouter } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { useBond } from "@/state/store";
import { useTokens } from "@/theme";
import { LockGate } from "@/protection/LockGate";

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const { c, scheme } = useTokens();
  const ready = useBond((s) => s.ready);
  const onboarded = useBond((s) => s.onboarded);
  const init = useBond((s) => s.init);
  const router = useRouter();

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  useEffect(() => {
    if (ready && !onboarded) router.replace("/onboarding");
  }, [ready, onboarded, router]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style={scheme === "dark" ? "light" : "dark"} />
        <View style={{ flex: 1, backgroundColor: c.bg }}>
          <LockGate>
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: c.bg },
              }}
            >
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="onboarding" options={{ animation: "fade" }} />
              <Stack.Screen name="bridge/connect" options={{ presentation: "modal" }} />
              <Stack.Screen name="wallet" options={{ presentation: "modal" }} />
              <Stack.Screen name="protection" options={{ presentation: "modal" }} />
              <Stack.Screen name="paywall" options={{ presentation: "modal" }} />
            </Stack>
          </LockGate>
        </View>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
