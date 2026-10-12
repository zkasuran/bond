// A themed numeric PIN pad and the modal sheet that wraps it. Both the app lock and any
// PIN guarded action (a spend, a key unlock) surface the same sheet. The settings screen
// reuses the pad to enroll or change a PIN. The digits are shuffled every time the pad is
// shown (see shuffle.ts), so the position of a tap does not give the PIN away.
import { useState } from "react";
import { Modal, Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Txt } from "@/components/ui/Text";
import { Button } from "@/components/ui/Button";
import { useTokens } from "@/theme";
import { padKeys, shuffledDigits, type Digit } from "./shuffle";

type Key = Digit | "" | "del";
const KEY_W = 72;
export const PIN_MAX_LENGTH = 6;
export const PIN_MIN_LENGTH = 4;

export function PinPad({
  value,
  onChange,
  maxLength = PIN_MAX_LENGTH,
}: {
  value: string;
  onChange: (next: string) => void;
  maxLength?: number;
}) {
  const { c, space, radius } = useTokens();
  // One layout per showing: drawn when the pad mounts and kept while the user types, so keys
  // do not move under a finger mid-entry. A new showing (or a new key prop) draws a new one.
  const [keys] = useState<Key[]>(() => padKeys(shuffledDigits()));
  const press = (k: Key) => {
    if (k === "") return;
    if (k === "del") {
      onChange(value.slice(0, -1));
      return;
    }
    if (value.length >= maxLength) return;
    onChange(value + k);
  };
  return (
    <View style={{ gap: space[5] }}>
      <View style={{ flexDirection: "row", justifyContent: "center", gap: space[3] }}>
        {Array.from({ length: maxLength }, (_, i) => {
          const filled = i < value.length;
          return (
            <View
              key={i}
              style={{
                width: 14,
                height: 14,
                borderRadius: radius.pill,
                borderWidth: 1.5,
                borderColor: filled ? c.brand : c.borderStrong,
                backgroundColor: filled ? c.brand : "transparent",
              }}
            />
          );
        })}
      </View>
      {/* Exactly three keys per row, like a phone keypad, so the blank and delete stay in the
          bottom corners whatever the screen width. */}
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: space[3],
          width: KEY_W * 3 + space[3] * 2,
          alignSelf: "center",
        }}
      >
        {keys.map((k, i) => (
          <Pressable
            key={i}
            onPress={() => press(k)}
            disabled={k === ""}
            accessibilityRole={k === "" ? "none" : "button"}
            accessibilityLabel={k === "del" ? "Delete" : k === "" ? undefined : `Digit ${k}`}
            style={({ pressed }) => ({
              width: KEY_W,
              height: 64,
              borderRadius: radius.lg,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: k === "" ? "transparent" : pressed ? c.surfaceSunken : c.surfaceAlt,
            })}
          >
            {k === "del" ? (
              <Ionicons name="backspace-outline" size={24} color={c.text} />
            ) : (
              <Txt variant="title" style={{ fontWeight: "600" }}>
                {k}
              </Txt>
            )}
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export function PinSheet({
  visible,
  title,
  subtitle,
  error,
  submitLabel = "Confirm",
  onSubmit,
  onCancel,
}: {
  visible: boolean;
  title: string;
  subtitle?: string;
  error?: string | null;
  submitLabel?: string;
  onSubmit: (pin: string) => void;
  onCancel: () => void;
}) {
  const { c, space, radius } = useTokens();
  const [pin, setPinValue] = useState("");
  // Bumped on every submit, so the next entry (the confirm step, a retry after a wrong PIN)
  // gets a fresh digit layout. Reopening the sheet remounts the pad, which also reshuffles.
  const [layout, setLayout] = useState(0);

  const submit = () => {
    if (pin.length < PIN_MIN_LENGTH) return;
    onSubmit(pin);
    setPinValue("");
    setLayout((n) => n + 1);
  };
  const cancel = () => {
    setPinValue("");
    onCancel();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={cancel}>
      <View
        style={{
          flex: 1,
          backgroundColor: "rgba(0,0,0,0.45)",
          justifyContent: "flex-end",
        }}
      >
        <View
          style={{
            backgroundColor: c.surface,
            borderTopLeftRadius: radius.xl,
            borderTopRightRadius: radius.xl,
            paddingHorizontal: space[5],
            paddingTop: space[5],
            paddingBottom: space[7],
            gap: space[5],
          }}
        >
          <View style={{ alignItems: "center", gap: space[2] }}>
            <View
              style={{
                width: 52,
                height: 52,
                borderRadius: radius.pill,
                backgroundColor: c.brandSoft,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Ionicons name="keypad" size={26} color={c.brand} />
            </View>
            <Txt variant="heading" style={{ textAlign: "center" }}>
              {title}
            </Txt>
            {subtitle ? (
              <Txt variant="caption" muted style={{ textAlign: "center" }}>
                {subtitle}
              </Txt>
            ) : null}
            {error ? (
              <Txt variant="caption" color={c.tampered} style={{ textAlign: "center" }}>
                {error}
              </Txt>
            ) : null}
          </View>

          <PinPad key={layout} value={pin} onChange={setPinValue} />

          <View style={{ gap: space[2] }}>
            <Button
              title={submitLabel}
              variant="primary"
              disabled={pin.length < PIN_MIN_LENGTH}
              onPress={submit}
            />
            <Button title="Cancel" variant="ghost" onPress={cancel} />
          </View>
        </View>
      </View>
    </Modal>
  );
}
