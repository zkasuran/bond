// The in-thread USDC pay sheet. A person taps the pay button on the composer, this sheet
// opens with the recipient defaulted to the thread peer and an amount field, then Send
// routes through the spend gate (requireAuth("spend")) before the wallet is ever asked to
// sign. Devnet USDC, no real funds. The sheet owns only its inputs and busy/error state;
// the actual send and gate live in state/store.sendPayment.
import { useState } from "react";
import { Modal, Pressable, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Animated, { ReduceMotion, SlideInDown } from "react-native-reanimated";
import { Txt } from "@/components/ui/Text";
import { Button } from "@/components/ui/Button";
import { useTokens } from "@/theme";
import { shortMiddle } from "./receipt";

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  testID,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  keyboardType?: "default" | "decimal-pad";
  testID?: string;
}) {
  const { c, space, radius, font } = useTokens();
  return (
    <View style={{ gap: space[2] }}>
      <Txt variant="label" faint>
        {label}
      </Txt>
      <TextInput
        testID={testID}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={c.textFaint}
        keyboardType={keyboardType ?? "default"}
        autoCapitalize="none"
        autoCorrect={false}
        style={{
          backgroundColor: c.surfaceAlt,
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

export function PaySheet({
  visible,
  defaultRecipient,
  selfAddress,
  onSubmit,
  onClose,
}: {
  visible: boolean;
  defaultRecipient: string;
  selfAddress: string | null;
  onSubmit: (toAddress: string, uiAmount: string, memo?: string) => Promise<void>;
  onClose: () => void;
}) {
  const { c, space, radius } = useTokens();
  // The recipient field starts empty on purpose. `defaultRecipient` is learned from room
  // payment nodes, whose `from`/`to` are attacker-chosen, so it is offered as a suggestion
  // the user must tap to apply, never silently trusted as the send-to address. The parent
  // remounts this sheet with a fresh key each time it opens, so these re-seed on open.
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suggestion = defaultRecipient.trim();
  const showSuggestion = suggestion.length > 0 && recipient.trim() !== suggestion;

  const canSend = recipient.trim().length > 0 && amount.trim().length > 0 && !busy;

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await onSubmit(recipient.trim(), amount.trim(), memo.trim() || undefined);
      onClose();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: c.scrim, justifyContent: "flex-end" }}>
        {/* Tapping the scrim dismisses, like any sheet. */}
        <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="Close pay sheet" />
        <Animated.View
          entering={SlideInDown.springify().damping(22).stiffness(200).reduceMotion(ReduceMotion.System)}
          style={{
            backgroundColor: c.surface,
            borderTopLeftRadius: radius.xl,
            borderTopRightRadius: radius.xl,
            borderWidth: 1,
            borderBottomWidth: 0,
            borderColor: c.border,
            paddingHorizontal: space[5],
            paddingTop: space[3],
            paddingBottom: space[7],
            gap: space[4],
          }}
        >
          <View style={{ alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: c.borderStrong }} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: space[3] }}>
            <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: c.brandSoft, alignItems: "center", justifyContent: "center" }}>
              <Ionicons name="logo-usd" size={20} color={c.brand} />
            </View>
            <View style={{ flex: 1 }}>
              <Txt variant="title">Send USDC</Txt>
              <Txt variant="caption" faint>Settles on Solana devnet</Txt>
            </View>
            <Button title="Close" variant="ghost" onPress={onClose} />
          </View>

          <Field label="Recipient address" value={recipient} onChangeText={setRecipient} placeholder="Solana address" testID="pay-recipient-input" />
          {showSuggestion ? (
            <Pressable
              testID="pay-recipient-suggestion"
              onPress={() => setRecipient(suggestion)}
              accessibilityRole="button"
              accessibilityLabel={`Use suggested recipient ${shortMiddle(suggestion)}`}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: space[2],
                backgroundColor: c.surfaceAlt,
                borderWidth: 1,
                borderColor: c.border,
                borderRadius: radius.md,
                paddingHorizontal: space[3],
                paddingVertical: space[2],
              }}
            >
              <Ionicons name="sparkles-outline" size={14} color={c.textMuted} />
              <View style={{ flex: 1 }}>
                <Txt variant="caption" faint>
                  From a recent payment in this chat. Check it before you use it.
                </Txt>
                <Txt variant="mono" muted numberOfLines={1} style={{ fontSize: 12 }}>
                  {shortMiddle(suggestion)}
                </Txt>
              </View>
              <Txt variant="caption" color={c.brand}>Use</Txt>
            </Pressable>
          ) : null}
          <Field label="Amount (USDC)" value={amount} onChangeText={setAmount} placeholder="0.00" keyboardType="decimal-pad" />
          <Field label="Memo (optional)" value={memo} onChangeText={setMemo} placeholder="What is this for?" />

          {selfAddress ? (
            <Txt variant="caption" faint>From {shortMiddle(selfAddress)}</Txt>
          ) : (
            <Txt variant="caption" color={c.warning}>
              Connect a wallet in the Wallet tab before sending.
            </Txt>
          )}

          <Button
            title="Send USDC"
            variant="primary"
            loading={busy}
            disabled={!canSend}
            onPress={() => void submit()}
            left={<Ionicons name="arrow-up-circle" size={16} color={c.onBrand} />}
          />

          <Txt variant="caption" faint>
            Devnet USDC, no real funds. You approve with your device protection before it signs.
          </Txt>
          {error ? (
            <Txt variant="caption" color={c.tampered}>{error}</Txt>
          ) : null}
        </Animated.View>
      </View>
    </Modal>
  );
}
