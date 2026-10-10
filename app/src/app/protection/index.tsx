// The protection settings screen. Pick which method guards each trigger, set the spend size
// that needs approval, choose how long an unlock is trusted and manage the app PIN. Every
// change writes straight through useProtection, so the gate enforces exactly what is shown
// here. Reachable at /protection.
import { useCallback, useEffect, useState, type ComponentProps } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { Screen } from "@/components/ui/Screen";
import { Txt } from "@/components/ui/Text";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { useTokens } from "@/theme";
import { useProtection } from "@/protection/LockGate";
import { PinSheet } from "@/protection/PinPad";
import {
  clearPin,
  getBiometricStatus,
  hasPin,
  setPin,
  type BiometricStatus,
} from "@/protection/gate";
import {
  METHODS,
  TRIGGERS,
  type ProtectionMethod,
  type Trigger,
} from "@/protection/policy";

type IoniconName = ComponentProps<typeof Ionicons>["name"];

const TRIGGER_META: Record<Trigger, { label: string; desc: string; icon: IoniconName }> = {
  openApp: {
    label: "Open Bond",
    desc: "Lock the whole app until you confirm it is you.",
    icon: "phone-portrait-outline",
  },
  runSkill: {
    label: "Run a skill",
    desc: "Confirm before an agent runs a skill for you.",
    icon: "flash-outline",
  },
  spend: {
    label: "Approve a payment",
    desc: "Confirm before the agent moves funds on Solana.",
    icon: "card-outline",
  },
  unlockKey: {
    label: "Use signing key",
    desc: "Confirm before your identity key signs anything.",
    icon: "key-outline",
  },
};

const METHOD_META: Record<ProtectionMethod, { label: string; icon: IoniconName }> = {
  none: { label: "Off", icon: "remove-circle-outline" },
  pin: { label: "PIN", icon: "keypad-outline" },
  biometric: { label: "Biometric", icon: "finger-print" },
};

const SPEND_STEPS = [0, 1, 5, 10, 25, 50, 100];
const WINDOW_STEPS = [0, 30, 60, 300, 900];

function windowLabel(sec: number): string {
  if (sec <= 0) return "Off";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

export default function ProtectionScreen() {
  const { c, space, radius } = useTokens();
  const router = useRouter();
  const policy = useProtection((s) => s.policy);
  const setPolicy = useProtection((s) => s.setPolicy);
  const setMethod = useProtection((s) => s.setMethod);
  const hydrate = useProtection((s) => s.hydrate);

  const [bio, setBio] = useState<BiometricStatus | null>(null);
  const [pinSet, setPinSet] = useState(false);
  const [enroll, setEnroll] = useState<null | { step: "choose" | "confirm"; first: string }>(null);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [pendingPinTrigger, setPendingPinTrigger] = useState<Trigger | null>(null);

  useEffect(() => {
    void hydrate();
    void getBiometricStatus().then(setBio);
    void hasPin().then(setPinSet);
  }, [hydrate]);

  const bioReady = !!bio && bio.hasHardware && bio.isEnrolled;

  const startEnroll = useCallback((trigger: Trigger | null) => {
    setPendingPinTrigger(trigger);
    setEnrollError(null);
    setEnroll({ step: "choose", first: "" });
  }, []);

  const selectMethod = useCallback(
    (trigger: Trigger, method: ProtectionMethod) => {
      if (method === "pin" && !pinSet) {
        startEnroll(trigger);
        return;
      }
      void setMethod(trigger, method);
    },
    [pinSet, setMethod, startEnroll],
  );

  const onEnrollSubmit = useCallback(
    async (pin: string) => {
      if (!enroll) return;
      if (enroll.step === "choose") {
        setEnrollError(null);
        setEnroll({ step: "confirm", first: pin });
        return;
      }
      if (pin !== enroll.first) {
        setEnrollError("PINs did not match. Try again.");
        setEnroll({ step: "choose", first: "" });
        return;
      }
      await setPin(pin);
      setPinSet(true);
      setEnroll(null);
      if (pendingPinTrigger) {
        await setMethod(pendingPinTrigger, "pin");
        setPendingPinTrigger(null);
      }
    },
    [enroll, pendingPinTrigger, setMethod],
  );

  const onEnrollCancel = useCallback(() => {
    setEnroll(null);
    setEnrollError(null);
    setPendingPinTrigger(null);
  }, []);

  const onRemovePin = useCallback(async () => {
    // Removing the PIN rewrites every pin trigger to "none", a protection downgrade. Prove the
    // current factor through the guarded setPolicy first, then clear the PIN only if it applied.
    const applied = await setPolicy((p) => ({
      ...p,
      methods: Object.fromEntries(
        TRIGGERS.map((t) => [t, p.methods[t] === "pin" ? "none" : p.methods[t]]),
      ) as Record<Trigger, ProtectionMethod>,
    }));
    if (!applied) return;
    await clearPin();
    setPinSet(false);
  }, [setPolicy]);

  return (
    <Screen edges={["top"]}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space[3],
          paddingHorizontal: space[4],
          paddingVertical: space[3],
        }}
      >
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={{
            width: 36,
            height: 36,
            borderRadius: radius.pill,
            backgroundColor: c.surfaceAlt,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Ionicons name="chevron-back" size={20} color={c.text} />
        </Pressable>
        <Txt variant="heading">Protection</Txt>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: space[4], paddingBottom: space[10], gap: space[6] }}
        showsVerticalScrollIndicator={false}
      >
        <Txt variant="body" muted>
          Choose how each action is protected. Bond gates at the app layer, so turning these on
          never risks your signing key.
        </Txt>

        <BiometricNote bio={bio} />

        {/* Per-trigger method */}
        <View>
          <SectionLabel>What to protect</SectionLabel>
          <Card style={{ gap: space[5] }}>
            {TRIGGERS.map((t, i) => (
              <View
                key={t}
                style={{
                  gap: space[3],
                  paddingTop: i === 0 ? 0 : space[4],
                  borderTopWidth: i === 0 ? 0 : 1,
                  borderTopColor: c.border,
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: space[3] }}>
                  <View style={{ width: 24, alignItems: "center" }}>
                    <Ionicons name={TRIGGER_META[t].icon} size={18} color={c.textMuted} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Txt variant="callout">{TRIGGER_META[t].label}</Txt>
                    <Txt variant="caption" muted>
                      {TRIGGER_META[t].desc}
                    </Txt>
                  </View>
                </View>
                <Segmented
                  value={policy.methods[t]}
                  bioReady={bioReady}
                  onChange={(m) => selectMethod(t, m)}
                />
              </View>
            ))}
          </Card>
        </View>

        <SpendCard
          value={policy.spendThresholdUsdc}
          onChange={(v) => void setPolicy({ spendThresholdUsdc: v })}
        />

        <WindowCard
          value={policy.reauthWindowSec}
          onChange={(v) => void setPolicy({ reauthWindowSec: v })}
        />

        <PinCard pinSet={pinSet} onSet={() => startEnroll(null)} onRemove={onRemovePin} />
      </ScrollView>

      <PinSheet
        visible={enroll !== null}
        title={enroll?.step === "confirm" ? "Confirm your PIN" : "Choose a PIN"}
        subtitle={
          enroll?.step === "confirm"
            ? "Enter it again to confirm."
            : "At least 4 digits. Used when biometrics are unavailable."
        }
        error={enrollError}
        submitLabel={enroll?.step === "confirm" ? "Save PIN" : "Next"}
        onSubmit={(pin) => void onEnrollSubmit(pin)}
        onCancel={onEnrollCancel}
      />
    </Screen>
  );
}

function SectionLabel({ children }: { children: string }) {
  const { space } = useTokens();
  return (
    <Txt
      variant="caption"
      faint
      style={{
        letterSpacing: 1,
        textTransform: "uppercase",
        marginBottom: space[2],
        marginLeft: space[1],
      }}
    >
      {children}
    </Txt>
  );
}

function BiometricNote({ bio }: { bio: BiometricStatus | null }) {
  const { c, space, radius } = useTokens();
  if (!bio) return null;
  let icon: IoniconName = "finger-print";
  let color: string = c.verified;
  let bg: string = c.verifiedSoft;
  let text: string;
  if (!bio.hasHardware) {
    icon = "phone-portrait-outline";
    color = c.textMuted;
    bg = c.surfaceAlt;
    text = "This device has no biometric sensor. Use a PIN. Bond falls back to it wherever biometrics are unavailable.";
  } else if (!bio.isEnrolled) {
    icon = "alert-circle-outline";
    color = c.warning;
    bg = c.surfaceAlt;
    text = "No fingerprint or face is enrolled. Add one in your device settings to use biometric unlock. A PIN works too.";
  } else {
    const names = bio.types
      .map((t) => (t === 1 ? "Fingerprint" : t === 2 ? "Face" : "Iris"))
      .join(" or ");
    text = `${names || "Biometrics"} ready${bio.strong ? "" : " (weak sensor, a PIN is stronger)"}.`;
  }
  return (
    <View
      style={{
        flexDirection: "row",
        gap: space[2],
        alignItems: "flex-start",
        backgroundColor: bg,
        borderRadius: radius.md,
        padding: space[3],
      }}
    >
      <Ionicons name={icon} size={16} color={color} style={{ marginTop: 1 }} />
      <Txt variant="caption" color={color} style={{ flex: 1, lineHeight: 18 }}>
        {text}
      </Txt>
    </View>
  );
}

function Segmented({
  value,
  bioReady,
  onChange,
}: {
  value: ProtectionMethod;
  bioReady: boolean;
  onChange: (m: ProtectionMethod) => void;
}) {
  const { c, space, radius } = useTokens();
  return (
    <View
      style={{
        flexDirection: "row",
        backgroundColor: c.surfaceSunken,
        borderRadius: radius.md,
        padding: 3,
        gap: 3,
      }}
    >
      {METHODS.map((m) => {
        const active = value === m;
        const dim = m === "biometric" && !bioReady;
        return (
          <Pressable
            key={m}
            onPress={() => onChange(m)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            style={{
              flex: 1,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: space[1],
              paddingVertical: space[2],
              borderRadius: radius.sm,
              backgroundColor: active ? c.surface : "transparent",
              borderWidth: active ? 1 : 0,
              borderColor: c.border,
            }}
          >
            <Ionicons
              name={METHOD_META[m].icon}
              size={14}
              color={active ? c.brand : dim ? c.textFaint : c.textMuted}
            />
            <Txt variant="caption" color={active ? c.brand : dim ? c.textFaint : c.textMuted}>
              {METHOD_META[m].label}
            </Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

function Chips({
  options,
  value,
  format,
  onChange,
}: {
  options: number[];
  value: number;
  format: (n: number) => string;
  onChange: (n: number) => void;
}) {
  const { c, space, radius } = useTokens();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[2] }}>
      {options.map((o) => {
        const active = value === o;
        return (
          <Pressable
            key={o}
            onPress={() => onChange(o)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            style={{
              paddingHorizontal: space[4],
              paddingVertical: space[2],
              borderRadius: radius.pill,
              backgroundColor: active ? c.brand : c.surfaceAlt,
              borderWidth: 1,
              borderColor: active ? c.brand : c.border,
            }}
          >
            <Txt variant="caption" color={active ? c.onBrand : c.textMuted}>
              {format(o)}
            </Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

function SpendCard({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const { space } = useTokens();
  return (
    <View>
      <SectionLabel>Payment approval</SectionLabel>
      <Card style={{ gap: space[3] }}>
        <Txt variant="caption" muted>
          {value <= 0
            ? "Every payment asks for approval."
            : `Payments of $${value} USDC or more ask for approval.`}
        </Txt>
        <Chips
          options={SPEND_STEPS}
          value={value}
          format={(n) => (n <= 0 ? "Every payment" : `$${n}`)}
          onChange={onChange}
        />
      </Card>
    </View>
  );
}

function WindowCard({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const { space } = useTokens();
  return (
    <View>
      <SectionLabel>Stay unlocked for</SectionLabel>
      <Card style={{ gap: space[3] }}>
        <Txt variant="caption" muted>
          {value <= 0
            ? "Ask every time, with no grace window."
            : `After you confirm, the same action stays unlocked for ${windowLabel(value)}.`}
        </Txt>
        <Chips options={WINDOW_STEPS} value={value} format={windowLabel} onChange={onChange} />
      </Card>
    </View>
  );
}

function PinCard({
  pinSet,
  onSet,
  onRemove,
}: {
  pinSet: boolean;
  onSet: () => void;
  onRemove: () => void;
}) {
  const { c, space } = useTokens();
  return (
    <View>
      <SectionLabel>App PIN</SectionLabel>
      <Card style={{ gap: space[3] }}>
        <Txt variant="caption" muted>
          {pinSet
            ? "A PIN is set. It unlocks anything you protect with PIN and covers you when biometrics are unavailable."
            : "Set a PIN to use it as a protection method and as a biometric fallback."}
        </Txt>
        <Button
          title={pinSet ? "Change PIN" : "Set a PIN"}
          variant="secondary"
          onPress={onSet}
          left={<Ionicons name="keypad-outline" size={16} color={c.text} />}
        />
        {pinSet ? <Button title="Remove PIN" variant="ghost" onPress={onRemove} /> : null}
      </Card>
    </View>
  );
}
