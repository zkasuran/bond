// Polyfill Web Crypto for on-device signing. Must run before any code that signs.
import "react-native-get-random-values";
import "@/global.css";

import { useEffect } from "react";
import { ScrollView, View } from "react-native";
import { Stack, useRouter } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { useBond } from "@/state/store";
import { useTokens } from "@/theme";
import { LockGate } from "@/protection/LockGate";
import { Txt } from "@/components/ui/Text";
import { Button } from "@/components/ui/Button";

void SplashScreen.preventAutoHideAsync();

// Expo Router renders a named `ErrorBoundary` export from a route in place of that route's
// subtree when it throws, so one bad screen shows a recoverable error instead of blanking
// the whole app (Hardened to ship, point 10). Kept self-contained: a plain themed view with
// a retry, so the fallback itself cannot depend on the thing that just failed.
export function ErrorBoundary({ error, retry }: { error: Error; retry: () => Promise<void> }) {
  const { c, space, radius } = useTokens();
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView
        contentContainerStyle={{ flexGrow: 1, alignItems: "center", justifyContent: "center", padding: space[6], gap: space[4] }}
      >
        <View
          style={{
            width: 72,
            height: 72,
            borderRadius: radius.pill,
            backgroundColor: c.tamperedSoft,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Ionicons name="warning-outline" size={34} color={c.tampered} />
        </View>
        <Txt variant="title" style={{ textAlign: "center" }}>This screen hit an error</Txt>
        <Txt variant="body" muted style={{ textAlign: "center" }}>
          The rest of Bond is fine. Try again or go back.
        </Txt>
        <Txt variant="mono" faint selectable style={{ textAlign: "center" }}>
          {String(error?.message ?? error)}
        </Txt>
        <Button title="Try again" variant="primary" onPress={() => void retry()} />
      </ScrollView>
    </View>
  );
}

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
              <Stack.Screen name="market/index" />
              <Stack.Screen name="market/[id]" />
            </Stack>
          </LockGate>
        </View>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
