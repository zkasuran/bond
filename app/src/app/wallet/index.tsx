// The Wallet screen. Connect a Seeker (or other MWA) wallet, see the SOL and USDC balance
// on devnet, send USDC to another member and price a SOL to USDC swap on Jupiter. Sending
// USDC runs on devnet with no real funds. Swap quotes are live mainnet prices and free to
// view; executing a swap is mainnet and moves real funds, so this screen shows the quote
// and leaves execution gated. Built on Bond's tokens and ui components.
import { useCallback, useEffect, useState } from "react";
import { Linking, Pressable, ScrollView, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { PublicKey } from "@solana/web3.js";
import { Screen } from "@/components/ui/Screen";
import { Txt } from "@/components/ui/Text";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useTokens } from "@/theme";
import { useBond } from "@/state/store";
import { useWallet } from "@/solana/store";
import { WalletConnectButton, shortenAddress } from "@/solana/WalletConnectButton";
import {
  getConnection,
  LAMPORTS_PER_SOL,
  SOLANA_CLUSTER,
  SOL_DECIMALS,
  USDC_DECIMALS,
  USDC_MAINNET_MINT,
  WSOL_MINT,
} from "@/solana/config";
import { buildUsdcTransfer, fromBaseUnits, getUsdcBalance, toBaseUnits } from "@/solana/usdc";
import { getQuote, summarizeQuote, type QuoteSummary } from "@/solana/swap";
import { signAndSendTransaction } from "@/solana/wallet";
import { explorerTxUrl } from "@/solana/explorer";
import { requireAuth } from "@/protection/gate";

function SectionLabel({ children }: { children: string }) {
  const { space } = useTokens();
  return (
    <Txt
      variant="caption"
      faint
      style={{ letterSpacing: 1, textTransform: "uppercase", marginBottom: space[2], marginLeft: space[1] }}
    >
      {children}
    </Txt>
  );
}
function Field({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  keyboardType?: "default" | "decimal-pad";
}) {
  const { c, space, radius, font } = useTokens();
  return (
    <View style={{ gap: space[2] }}>
      <Txt variant="caption" faint style={{ letterSpacing: 0.6 }}>
        {label.toUpperCase()}
      </Txt>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={c.textFaint}
        keyboardType={keyboardType ?? "default"}
        autoCapitalize="none"
        autoCorrect={false}
        style={{
          backgroundColor: c.surfaceSunken,
          borderWidth: 1,
          borderColor: c.border,
          borderRadius: radius.md,
          paddingVertical: space[3],
          paddingHorizontal: space[3],
          color: c.text,
          fontFamily: font.mono,
          fontSize: 14,
        }}
      />
    </View>
  );
}

function Row({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  const { space } = useTokens();
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: space[1] }}>
      <Txt variant="callout" muted>
        {label}
      </Txt>
      <Txt variant="callout" color={valueColor} style={{ maxWidth: "60%", textAlign: "right" }} numberOfLines={1}>
        {value}
      </Txt>
    </View>
  );
}

/** Format a USDC price per SKR for display, trimming trailing zeros. Six decimals keeps a
 *  sub-cent price readable without turning into scientific notation. */
export function formatSkrPrice(priceInUsdc: number): string {
  if (!Number.isFinite(priceInUsdc) || priceInUsdc <= 0) return "unavailable";
  const trimmed = priceInUsdc.toFixed(6).replace(/\.?0+$/, "");
  return `1 SKR = ${trimmed} USDC`;
}
export default function WalletScreen() {
  const { c, space } = useTokens();
  const identity = useBond((s) => s.identity);
  const address = useWallet((s) => s.connectedAddress);
  const authToken = useWallet((s) => s.authToken);
  const binding = useWallet((s) => s.binding);
  const bindIdentity = useWallet((s) => s.bindIdentity);
  const loadStoredBinding = useWallet((s) => s.loadStoredBinding);
  const skr = useBond((s) => s.skr);
  const refreshSkr = useBond((s) => s.refreshSkr);

  const [sol, setSol] = useState<string | null>(null);
  const [usdc, setUsdc] = useState<string | null>(null);
  const [loadingBalance, setLoadingBalance] = useState(false);

  const [recipient, setRecipient] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const [swapAmount, setSwapAmount] = useState("");
  const [quote, setQuote] = useState<QuoteSummary | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [swapError, setSwapError] = useState<string | null>(null);
  const refreshBalance = useCallback(async () => {
    if (!address) return;
    setLoadingBalance(true);
    try {
      const connection = getConnection();
      const owner = new PublicKey(address);
      const lamports = await connection.getBalance(owner);
      setSol((lamports / LAMPORTS_PER_SOL).toString());
      const bal = await getUsdcBalance(connection, owner);
      setUsdc(bal.uiAmount);
    } catch {
      setSol(null);
      setUsdc(null);
    } finally {
      setLoadingBalance(false);
    }
  }, [address]);

  useEffect(() => {
    if (identity) void loadStoredBinding(identity.did);
  }, [identity, loadStoredBinding]);

  useEffect(() => {
    // Defer the first refresh out of the effect body so the loading flag is not set
    // synchronously during render. Cleared on unmount.
    const t = setTimeout(() => void refreshBalance(), 0);
    return () => clearTimeout(t);
  }, [refreshBalance]);

  useEffect(() => {
    // SKR is read live from mainnet and needs no wallet for the price, so refresh on mount
    // and whenever the connected address changes. refreshSkr is optional-called so a mocked
    // store without it never crashes the screen.
    const t = setTimeout(() => void refreshSkr?.(address ?? null), 0);
    return () => clearTimeout(t);
  }, [address, refreshSkr]);
  const onSend = useCallback(async () => {
    setSendError(null);
    setSendResult(null);
    if (!address || !authToken) {
      setSendError("Connect a wallet first.");
      return;
    }
    let to: PublicKey;
    try {
      to = new PublicKey(recipient.trim());
    } catch {
      setSendError("That recipient is not a valid Solana address.");
      return;
    }
    // Parse with the transfer's own decimal parser so the gate sees the real amount.
    let amountUsdc: number;
    try {
      const base = toBaseUnits(sendAmount.trim(), USDC_DECIMALS);
      if (base <= 0n) throw new Error("Amount must be greater than zero");
      amountUsdc = Number(fromBaseUnits(base, USDC_DECIMALS));
    } catch {
      setSendError("Enter a valid USDC amount.");
      return;
    }
    setSending(true);
    try {
      // Route through the spend gate before building or signing anything, the same gate the
      // in-thread pay flow uses. A denied or fail-closed gate stops the send here.
      const gate = await requireAuth("spend", { amountUsdc });
      if (!gate.ok) {
        setSendError(
          gate.outcome === "no_pin"
            ? "Set a PIN in Protection to approve payments."
            : gate.outcome === "locked_out"
              ? "Too many attempts. Try again shortly."
              : "Payment was not approved.",
        );
        return;
      }
      const connection = getConnection();
      const built = await buildUsdcTransfer(connection, new PublicKey(address), to, sendAmount.trim());
      const signature = await signAndSendTransaction(built.transaction, { authToken });
      setSendResult(signature);
      setSendAmount("");
      void refreshBalance();
    } catch (e) {
      setSendError(String((e as Error)?.message ?? e));
    } finally {
      setSending(false);
    }
  }, [address, authToken, recipient, sendAmount, refreshBalance]);

  const onQuote = useCallback(async () => {
    setSwapError(null);
    setQuote(null);
    const amount = Number(swapAmount.trim());
    if (!Number.isFinite(amount) || amount <= 0) {
      setSwapError("Enter a SOL amount to quote.");
      return;
    }
    setQuoting(true);
    try {
      const lamports = Math.round(amount * LAMPORTS_PER_SOL);
      const raw = await getQuote({ inputMint: WSOL_MINT, outputMint: USDC_MAINNET_MINT, amount: lamports });
      setQuote(summarizeQuote(raw, SOL_DECIMALS, USDC_DECIMALS));
    } catch (e) {
      setSwapError(String((e as Error)?.message ?? e));
    } finally {
      setQuoting(false);
    }
  }, [swapAmount]);

  const onBind = useCallback(async () => {
    if (identity) await bindIdentity(identity.did);
  }, [identity, bindIdentity]);
  return (
    <Screen edges={["top"]}>
      <ScrollView
        contentContainerStyle={{ padding: space[4], paddingBottom: space[10], gap: space[6] }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ gap: space[1] }}>
          <Txt variant="display">Wallet</Txt>
          <Txt variant="body" muted>
            Connect your Seeker wallet, send USDC and price a swap.
          </Txt>
        </View>

        <View>
          <SectionLabel>Wallet</SectionLabel>
          <Card style={{ gap: space[4] }}>
            <WalletConnectButton />
            {address ? (
              <View style={{ gap: space[2] }}>
                <Row label="SOL" value={loadingBalance ? "…" : (sol ?? "unavailable")} />
                <Row label="USDC (devnet)" value={loadingBalance ? "…" : (usdc ?? "unavailable")} />
                <Button title="Refresh balance" variant="ghost" onPress={() => void refreshBalance()} />
              </View>
            ) : null}
          </Card>
        </View>
        {address && identity ? (
          <View>
            <SectionLabel>Identity binding</SectionLabel>
            <Card style={{ gap: space[3] }}>
              <Txt variant="caption" muted>
                Tie this wallet to your device identity with one signature. Your did:key keeps
                signing messages while the wallet is your on-chain identity and USDC payer.
              </Txt>
              {binding ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
                  <Ionicons name="shield-checkmark" size={16} color={c.verified} />
                  <Txt variant="callout" color={c.verified}>
                    Bound to {shortenAddress(binding.walletAddress)}
                  </Txt>
                </View>
              ) : (
                <Button title="Bind wallet to identity" variant="secondary" onPress={() => void onBind()} />
              )}
            </Card>
          </View>
        ) : null}
        <View>
          <SectionLabel>Send USDC</SectionLabel>
          <Card style={{ gap: space[4] }}>
            <Field label="Recipient address" value={recipient} onChangeText={setRecipient} placeholder="Solana address" />
            <Field label="Amount (USDC)" value={sendAmount} onChangeText={setSendAmount} placeholder="0.00" keyboardType="decimal-pad" />
            <Button
              title="Send USDC"
              variant="primary"
              loading={sending}
              disabled={!address}
              onPress={() => void onSend()}
              left={<Ionicons name="arrow-up-circle" size={16} color="#FFFFFF" />}
            />
            <Txt variant="caption" faint>
              Devnet USDC, no real funds. A recipient token account is created for free when it
              does not exist yet.
            </Txt>
            {sendResult ? (
              <View style={{ gap: space[1] }}>
                <Txt variant="mono" color={c.verified} selectable>
                  Submitted. Signature {shortenAddress(sendResult, 8, 8)}
                </Txt>
                <Pressable
                  onPress={() => void Linking.openURL(explorerTxUrl(sendResult, SOLANA_CLUSTER)).catch(() => {})}
                  hitSlop={6}
                  accessibilityRole="link"
                  style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
                >
                  <Ionicons name="open-outline" size={13} color={c.brand} />
                  <Txt variant="caption" color={c.brand}>View on Solana Explorer (devnet)</Txt>
                </Pressable>
              </View>
            ) : null}
            {sendError ? (
              <Txt variant="caption" color={c.tampered}>
                {sendError}
              </Txt>
            ) : null}
          </Card>
        </View>
        <View>
          <SectionLabel>Swap SOL to USDC</SectionLabel>
          <Card style={{ gap: space[4] }}>
            <Field label="Amount (SOL)" value={swapAmount} onChangeText={setSwapAmount} placeholder="0.0" keyboardType="decimal-pad" />
            <Button title="Get quote" variant="secondary" loading={quoting} onPress={() => void onQuote()} />
            {quote ? (
              <View style={{ gap: space[1] }}>
                <Row label="You pay" value={`${quote.inUiAmount} SOL`} />
                <Row label="You receive" value={`${quote.outUiAmount} USDC`} valueColor={c.verified} />
                <Row label="Rate" value={`1 SOL = ${quote.rate.toFixed(2)} USDC`} />
                <Row label="Min received" value={`${quote.minReceivedUiAmount} USDC`} />
                <Row label="Price impact" value={`${(quote.priceImpactPct * 100).toFixed(3)} %`} />
                <Row label="Route" value={quote.route.join(" to ") || "direct"} />
              </View>
            ) : null}
            <View
              style={{
                flexDirection: "row",
                gap: space[2],
                alignItems: "flex-start",
                backgroundColor: c.surfaceAlt,
                borderRadius: 12,
                padding: space[3],
              }}
            >
              <Ionicons name="information-circle" size={16} color={c.warning} style={{ marginTop: 1 }} />
              <Txt variant="caption" color={c.warning} style={{ flex: 1 }}>
                Quotes are live mainnet prices. Executing a swap runs on mainnet with real funds,
                so it stays gated behind an explicit funded confirmation.
              </Txt>
            </View>
            {swapError ? (
              <Txt variant="caption" color={c.tampered}>
                {swapError}
              </Txt>
            ) : null}
          </Card>
        </View>
        <View>
          <SectionLabel>SKR (mainnet)</SectionLabel>
          <Card style={{ gap: space[2] }}>
            <Row
              label="SKR price"
              value={skr?.loading ? "…" : formatSkrPrice(skr?.priceInUsdc ?? 0)}
            />
            <Row
              label="Your SKR"
              value={
                !address
                  ? "connect a wallet"
                  : skr?.loading
                    ? "…"
                    : `${skr?.balanceUi ?? "0"} SKR`
              }
              valueColor={skr?.isHolder ? c.verified : undefined}
            />
            <Button title="Refresh SKR" variant="ghost" onPress={() => void refreshSkr?.(address ?? null)} />
            <Txt variant="caption" faint>
              SKR price and balance are read live from Solana mainnet. Nothing is signed and no
              SKR is moved. Skill purchases settle in devnet USDC for this hackathon build.
            </Txt>
            {skr?.error ? (
              <Txt variant="caption" color={c.tampered}>
                {skr.error}
              </Txt>
            ) : null}
          </Card>
        </View>
      </ScrollView>
    </Screen>
  );
}
