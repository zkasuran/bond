// The Wallet screen. Connect a Seeker (or other MWA) wallet, see the SOL and USDC balance
// on devnet, send USDC to another member and price a SOL to USDC swap on Jupiter. Sending
// USDC runs on devnet with no real funds. Swap quotes are live mainnet prices and free to
// view; executing a swap is mainnet and moves real funds, so this screen shows the quote
// and leaves execution gated. Built on Bond's tokens and ui components.
import { useCallback, useEffect, useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
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
  SOL_DECIMALS,
  USDC_DECIMALS,
  USDC_MAINNET_MINT,
  WSOL_MINT,
} from "@/solana/config";
import { buildUsdcTransfer, getUsdcBalance } from "@/solana/usdc";
import { getQuote, summarizeQuote, type QuoteSummary } from "@/solana/swap";
import { signAndSendTransaction } from "@/solana/wallet";

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
  const { c, space } = useTokens();
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
export default function WalletScreen() {
  const { c, space } = useTokens();
  const identity = useBond((s) => s.identity);
  const address = useWallet((s) => s.connectedAddress);
  const authToken = useWallet((s) => s.authToken);
  const binding = useWallet((s) => s.binding);
  const bindIdentity = useWallet((s) => s.bindIdentity);
  const loadStoredBinding = useWallet((s) => s.loadStoredBinding);

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
    void refreshBalance();
  }, [refreshBalance]);
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
    setSending(true);
    try {
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
              <Txt variant="mono" color={c.verified} selectable>
                Sent. Signature {shortenAddress(sendResult, 8, 8)}
              </Txt>
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
      </ScrollView>
    </Screen>
  );
}
