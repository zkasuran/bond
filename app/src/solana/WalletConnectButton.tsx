// The wallet connect control, dropped into any screen (mount it in the You tab). It reads
// the wallet store and shows one of three states: a Connect button, a connected row with the
// short address plus Disconnect, else a disabled note off Android where MWA cannot run. All
// work lives in the store, so this stays a thin presentational component on Bond's tokens.
import { useCallback } from "react";
import { View, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Button, type ButtonVariant } from "@/components/ui/Button";
import { Txt } from "@/components/ui/Text";
import { useTokens } from "@/theme";
import { useWallet } from "./store";

/** Shorten a base58 address for display, keeping the ends that identify it. */
export function shortenAddress(address: string, lead = 4, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

export function WalletConnectButton({
  variant = "primary",
  onConnected,
  style,
}: {
  variant?: ButtonVariant;
  onConnected?: (address: string) => void;
  style?: ViewStyle;
}) {
  const { c, space, radius } = useTokens();
  const available = useWallet((s) => s.available);
  const connecting = useWallet((s) => s.connecting);
  const address = useWallet((s) => s.connectedAddress);
  const label = useWallet((s) => s.label);
  const error = useWallet((s) => s.error);
  const connect = useWallet((s) => s.connect);
  const disconnect = useWallet((s) => s.disconnect);

  const onConnect = useCallback(async () => {
    const conn = await connect();
    if (conn) onConnected?.(conn.address);
  }, [connect, onConnected]);

  if (!available) {
    return (
      <View style={[{ gap: space[2] }, style]}>
        <Button title="Connect wallet" variant="secondary" disabled onPress={() => {}} />
        <Txt variant="caption" faint>
          Wallet features run on an Android device with a Seeker or other MWA wallet.
        </Txt>
      </View>
    );
  }

  if (address) {
    return (
      <View style={[{ gap: space[2] }, style]}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space[3],
            backgroundColor: c.surfaceAlt,
            borderRadius: radius.md,
            paddingVertical: space[3],
            paddingHorizontal: space[4],
          }}
        >
          <Ionicons name="wallet" size={18} color={c.brand} />
          <View style={{ flex: 1 }}>
            <Txt variant="callout">{label ?? "Wallet"}</Txt>
            <Txt variant="mono" muted>
              {shortenAddress(address)}
            </Txt>
          </View>
          <Button title="Disconnect" variant="ghost" onPress={() => void disconnect()} />
        </View>
      </View>
    );
  }

  return (
    <View style={[{ gap: space[2] }, style]}>
      <Button
        title="Connect wallet"
        variant={variant}
        loading={connecting}
        onPress={() => void onConnect()}
        left={<Ionicons name="wallet-outline" size={16} color={variant === "primary" ? c.onBrand : c.brand} />}
      />
      {error ? (
        <Txt variant="caption" color={c.tampered}>
          {error}
        </Txt>
      ) : null}
    </View>
  );
}
