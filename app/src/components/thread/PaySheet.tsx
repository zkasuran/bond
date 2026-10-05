// The in-thread USDC pay sheet. A person taps the pay button on the composer, this sheet
// opens with the recipient defaulted to the thread peer and an amount field, then Send
// routes through the spend gate (requireAuth("spend")) before the wallet is ever asked to
// sign. Devnet USDC, no real funds. The sheet owns only its inputs and busy/error state;
// the actual send and gate live in state/store.sendPayment.
import { useState } from "react";
import { Modal, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
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
  // State initializes from the open-time props. The parent remounts this sheet with a fresh
  // key each time it opens, so these initial values re-seed without a setState-in-effect.
  const [recipient, setRecipient] = useState(defaultRecipient);
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" }}>
        <View
          style={{
            backgroundColor: c.surface,
            borderTopLeftRadius: radius.xl,
            borderTopRightRadius: radius.xl,
            paddingHorizontal: space[5],
            paddingTop: space[5],
            paddingBottom: space[7],
            gap: space[4],
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
            <Ionicons name="cash-outline" size={22} color={c.brand} />
            <Txt variant="heading" style={{ flex: 1 }}>Send USDC</Txt>
            <Button title="Close" variant="ghost" onPress={onClose} />
          </View>

          <Field label="Recipient address" value={recipient} onChangeText={setRecipient} placeholder="Solana address" />
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
            left={<Ionicons name="arrow-up-circle" size={16} color="#FFFFFF" />}
          />

          <Txt variant="caption" faint>
            Devnet USDC, no real funds. You approve with your device protection before it signs.
          </Txt>
          {error ? (
            <Txt variant="caption" color={c.tampered}>{error}</Txt>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}
