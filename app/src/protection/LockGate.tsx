// LockGate blocks the app behind the openApp trigger and re-locks when the app returns
// from the background. It hosts the one PIN sheet that every PIN guarded action shares.
// useProtection is the store the settings screen and this gate both read, so the policy on
// screen and the policy the gate enforces are the same object.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AppState, type AppStateStatus, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { create } from "zustand";
import { Screen } from "@/components/ui/Screen";
import { Txt } from "@/components/ui/Text";
import { Button } from "@/components/ui/Button";
import { useTokens } from "@/theme";
import { PinSheet } from "./PinPad";
import {
  getLastAuthAt,
  isWithinGrace,
  requireAuth,
  setPinPrompter,
  type PinPromptRequest,
} from "./gate";
import {
  DEFAULT_POLICY,
  loadProtectionPolicy,
  saveProtectionPolicy,
  type ProtectionMethod,
  type ProtectionPolicy,
  type Trigger,
} from "./policy";

interface ProtectionStore {
  policy: ProtectionPolicy;
  ready: boolean;
  hydrate: () => Promise<void>;
  refresh: () => Promise<void>;
  setPolicy: (
    patch: Partial<ProtectionPolicy> | ((p: ProtectionPolicy) => ProtectionPolicy),
  ) => Promise<void>;
  setMethod: (trigger: Trigger, method: ProtectionMethod) => Promise<void>;
}

export const useProtection = create<ProtectionStore>((set, get) => ({
  policy: { ...DEFAULT_POLICY, methods: { ...DEFAULT_POLICY.methods } },
  ready: false,
  hydrate: async () => {
    if (get().ready) return;
    set({ policy: await loadProtectionPolicy(), ready: true });
  },
  refresh: async () => {
    set({ policy: await loadProtectionPolicy(), ready: true });
  },
  setPolicy: async (patch) => {
    const current = get().policy;
    const next = typeof patch === "function" ? patch(current) : { ...current, ...patch };
    const saved = await saveProtectionPolicy(next);
    set({ policy: saved });
  },
  setMethod: async (trigger, method) => {
    await get().setPolicy((p) => ({ ...p, methods: { ...p.methods, [trigger]: method } }));
  },
}));

interface PinReq extends PinPromptRequest {
  resolve: (pin: string | null) => void;
}

export function LockGate({ children }: { children: ReactNode }) {
  const { c, space, radius } = useTokens();
  const ready = useProtection((s) => s.ready);
  const hydrate = useProtection((s) => s.hydrate);
  const openAppMethod = useProtection((s) => s.policy.methods.openApp);
  const reauthWindowSec = useProtection((s) => s.policy.reauthWindowSec);

  const [unlocked, setUnlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attemptError, setAttemptError] = useState<string | null>(null);
  const [pinReq, setPinReq] = useState<PinReq | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Host the one PIN sheet for the whole app. Any requireAuth that needs a PIN, from the
  // lock screen or from a spend deep in the store, resolves through this.
  useEffect(() => {
    setPinPrompter((req) => new Promise<string | null>((resolve) => {
      setPinError(null);
      setPinReq({ ...req, resolve });
    }));
    return () => setPinPrompter(null);
  }, []);

  const unlock = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setAttemptError(null);
    try {
      const r = await requireAuth("openApp");
      if (r.ok) {
        setUnlocked(true);
      } else {
        setAttemptError(
          r.outcome === "cancelled" ? "Authentication cancelled." : "Could not verify. Try again.",
        );
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  // The lock is derived, not stored, so the effect below never sets state synchronously: it
  // only kicks off the async prompt when the app is ready, openApp is guarded and we are not
  // already unlocked. On success unlock() flips unlocked; a failure leaves the retry button.
  const showLock = !ready || (openAppMethod !== "none" && !unlocked);

  useEffect(() => {
    if (!ready || openAppMethod === "none" || unlocked) return;
    void unlock();
  }, [ready, openAppMethod, unlocked, unlock]);

  // Re-lock when the app returns to the foreground, unless a recent unlock is still inside
  // its grace window. Dropping unlocked re-arms the effect above, which re-prompts.
  useEffect(() => {
    if (!ready || openAppMethod === "none") return;
    let prev = AppState.currentState;
    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      const returned = (prev === "background" || prev === "inactive") && next === "active";
      prev = next;
      if (!returned) return;
      if (isWithinGrace(getLastAuthAt("openApp"), reauthWindowSec)) return;
      setUnlocked(false);
    });
    return () => sub.remove();
  }, [ready, openAppMethod, reauthWindowSec]);

  const onPinSubmit = (pin: string) => {
    const req = pinReq;
    setPinReq(null);
    req?.resolve(pin);
  };
  const onPinCancel = () => {
    const req = pinReq;
    setPinReq(null);
    req?.resolve(null);
  };

  const pinSheet = (
    <PinSheet
      visible={pinReq !== null}
      title={pinReq?.title ?? "Enter your PIN"}
      subtitle={pinReq?.subtitle}
      error={pinError}
      submitLabel="Unlock"
      onSubmit={onPinSubmit}
      onCancel={onPinCancel}
    />
  );

  if (showLock) {
    return (
      <>
        <Screen>
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space[5], padding: space[6] }}>
            <View
              style={{
                width: 88,
                height: 88,
                borderRadius: radius.pill,
                backgroundColor: c.brandSoft,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Ionicons name="lock-closed" size={40} color={c.brand} />
            </View>
            <View style={{ alignItems: "center", gap: space[2] }}>
              <Txt variant="title">Bond is locked</Txt>
              <Txt variant="body" muted style={{ textAlign: "center" }}>
                {openAppMethod === "pin"
                  ? "Enter your PIN to continue."
                  : "Confirm it is you to continue."}
              </Txt>
              {attemptError ? (
                <Txt variant="caption" color={c.tampered} style={{ textAlign: "center" }}>
                  {attemptError}
                </Txt>
              ) : null}
            </View>
            {ready ? (
              <Button
                title="Unlock"
                variant="primary"
                loading={busy}
                onPress={() => void unlock()}
                left={<Ionicons name="finger-print" size={16} color="#FFFFFF" />}
              />
            ) : null}
          </View>
        </Screen>
        {pinSheet}
      </>
    );
  }

  return (
    <>
      {children}
      {pinSheet}
    </>
  );
}
