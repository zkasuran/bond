// Bond onboarding. A four step, single-file flow using local step state, no extra routes.
// It opens on the mark bonding into place, learns a little about you, then makes the core
// idea concrete by showing your real device key as both a did:key and a Solana address.
// Steps glide in the direction you travel; everything honours reduced motion.
import { useEffect, useState, type ComponentProps } from "react";
import { Platform, Pressable, View } from "react-native";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import Animated, {
  Easing,
  FadeInLeft,
  FadeInRight,
  FadeOutLeft,
  FadeOutRight,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Screen } from "@/components/ui/Screen";
import { Txt } from "@/components/ui/Text";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { VerifiedBadge } from "@/components/ui/Badge";
import { BondMark } from "@/components/motion/BondMark";
import { AmbientGlow } from "@/components/motion/Ambient";
import { PressableScale } from "@/components/motion/PressableScale";
import { didToSolanaAddress } from "@/identity/keys";
import { useBond } from "@/state/store";
import { useTokens } from "@/theme";
import { enter, spring } from "@/theme/motion";

const STEP_COUNT = 4;
type IconName = ComponentProps<typeof Ionicons>["name"];

/** Shorten a long identifier so both ends stay readable, keeping the value concrete. */
function truncateMiddle(value: string, head = 16, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function safeAddress(did: string): string {
  try {
    return did ? didToSolanaAddress(did) : "";
  } catch {
    return "";
  }
}

function tap() {
  if (Platform.OS !== "web") void Haptics.selectionAsync().catch(() => {});
}

/** One step pill. The active one stretches on a spring; done ones stay lit. */
function ProgressPill({ state }: { state: "done" | "active" | "todo" }) {
  const { c, radius } = useTokens();
  const w = useSharedValue(state === "active" ? 26 : 7);
  useEffect(() => {
    w.set(withSpring(state === "active" ? 26 : 7, spring.gentle));
  }, [state, w]);
  const style = useAnimatedStyle(() => ({ width: w.get() }));
  return (
    <Animated.View
      style={[
        {
          height: 7,
          borderRadius: radius.pill,
          backgroundColor: state === "todo" ? c.borderStrong : c.brand,
          opacity: state === "done" ? 0.45 : 1,
        },
        style,
      ]}
    />
  );
}

/** A single-select personalization chip. Choosing is optional and lives in local state. */
function Chip({
  label,
  icon,
  selected,
  onPress,
}: {
  label: string;
  icon: IconName;
  selected: boolean;
  onPress: () => void;
}) {
  const { c, radius, space } = useTokens();
  return (
    <PressableScale
      onPress={() => {
        tap();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space[2],
        paddingVertical: space[3],
        paddingHorizontal: space[4],
        borderRadius: radius.pill,
        borderWidth: 1.5,
        borderColor: selected ? c.brand : c.border,
        backgroundColor: selected ? c.brandSoft : c.surface,
      }}
    >
      <Ionicons name={selected ? "checkmark-circle" : icon} size={18} color={selected ? c.brand : c.textMuted} />
      <Txt variant="callout" color={selected ? c.brand : c.text}>
        {label}
      </Txt>
    </PressableScale>
  );
}

/** The glowing thread between your did:key and your Solana address: a packet rides it. */
function KeyLink() {
  const { c } = useTokens();
  const reduced = useReducedMotion();
  const t = useSharedValue(0);
  useEffect(() => {
    if (reduced) return;
    t.set(withRepeat(withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.cubic) }), -1));
  }, [reduced, t]);
  const dot = useAnimatedStyle(() => ({ transform: [{ translateY: t.get() * 30 }], opacity: 1 - Math.abs(t.get() - 0.5) }));
  return (
    <View style={{ height: 36, width: 22, alignItems: "center", marginLeft: 6 }}>
      <View style={{ width: 2, height: "100%", borderRadius: 1, backgroundColor: c.brand + "44" }} />
      <Animated.View
        style={[
          { position: "absolute", top: 0, width: 8, height: 8, borderRadius: 4, backgroundColor: c.brand, boxShadow: `0px 0px 10px ${c.brand}` },
          dot,
        ]}
      />
    </View>
  );
}

function FeatureRow({ icon, tint, soft, title, body, index }: { icon: IconName; tint: string; soft: string; title: string; body: string; index: number }) {
  const { radius, space } = useTokens();
  return (
    <Animated.View entering={enter.row(index + 2)} style={{ flexDirection: "row", gap: space[3], alignItems: "flex-start" }}>
      <View style={{ width: 42, height: 42, borderRadius: radius.md, backgroundColor: soft, alignItems: "center", justifyContent: "center" }}>
        <Ionicons name={icon} size={20} color={tint} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Txt variant="heading">{title}</Txt>
        <Txt variant="caption" muted style={{ lineHeight: 18 }}>
          {body}
        </Txt>
      </View>
    </Animated.View>
  );
}

type Who = "solo" | "team";
type Connect = "assistant" | "own";

export default function Onboarding() {
  const { c, space } = useTokens();
  const router = useRouter();
  const identity = useBond((s) => s.identity);

  const [step, setStep] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);
  const [who, setWho] = useState<Who | null>(null);
  const [connect, setConnect] = useState<Connect | null>(null);
  const [busy, setBusy] = useState(false);

  const go = (next: number) => {
    tap();
    setDir(next > step ? 1 : -1);
    setStep(next);
  };

  const finish = async () => {
    setBusy(true);
    try {
      await useBond.getState().completeOnboarding();
      router.replace("/");
    } finally {
      setBusy(false);
    }
  };
  const did = identity?.did ?? "";
  const address = safeAddress(did);
  const isLast = step === STEP_COUNT - 1;

  const entering = (dir > 0 ? FadeInRight : FadeInLeft).springify().damping(20).stiffness(170).reduceMotion(ReduceMotion.System);
  const exiting = (dir > 0 ? FadeOutLeft : FadeOutRight).duration(160).reduceMotion(ReduceMotion.System);

  const renderStep = () => {
    switch (step) {
      case 0:
        return (
          <View style={{ flex: 1, justifyContent: "center", gap: space[7] }}>
            <View style={{ alignItems: "flex-start", justifyContent: "center", height: 150, paddingLeft: space[3] }}>
              <BondMark size={72} animate rings breathe delay={150} />
            </View>
            <View style={{ gap: space[3] }}>
              <Animated.View entering={enter.hero(3)}>
                <Txt variant="label" color={c.brand}>
                  Built for Solana Seeker
                </Txt>
              </Animated.View>
              <Animated.View entering={enter.hero(4)}>
                <Txt variant="hero">
                  Humans and agents, as <Txt variant="hero" color={c.brand}>paid peers.</Txt>
                </Txt>
              </Animated.View>
              <Animated.View entering={enter.hero(5)}>
                <Txt variant="body" muted style={{ maxWidth: 340 }}>
                  One room where every member, human or AI, holds a key that is also a Solana
                  wallet. Talk, delegate and pay in USDC, right in the thread.
                </Txt>
              </Animated.View>
            </View>
          </View>
        );
      case 1:
        return (
          <View style={{ flex: 1, justifyContent: "center", gap: space[6] }}>
            <View style={{ gap: space[2] }}>
              <Txt variant="label" color={c.brand}>
                Step 2 of 4
              </Txt>
              <Txt variant="display">A little about you</Txt>
              <Txt variant="body" muted>
                This tunes your first room. Change any of it later or skip ahead.
              </Txt>
            </View>
            <View style={{ gap: space[3] }}>
              <Txt variant="callout" muted>
                Who is in your rooms?
              </Txt>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[2] }}>
                <Chip label="Just me" icon="person-outline" selected={who === "solo"} onPress={() => setWho(who === "solo" ? null : "solo")} />
                <Chip label="A team" icon="people-outline" selected={who === "team"} onPress={() => setWho(who === "team" ? null : "team")} />
              </View>
            </View>
            <View style={{ gap: space[3] }}>
              <Txt variant="callout" muted>
                What will you connect?
              </Txt>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[2] }}>
                <Chip
                  label="An assistant"
                  icon="sparkles-outline"
                  selected={connect === "assistant"}
                  onPress={() => setConnect(connect === "assistant" ? null : "assistant")}
                />
                <Chip
                  label="My own agents"
                  icon="hardware-chip-outline"
                  selected={connect === "own"}
                  onPress={() => setConnect(connect === "own" ? null : "own")}
                />
              </View>
            </View>
          </View>
        );
      case 2:
        return (
          <View style={{ flex: 1, justifyContent: "center", gap: space[6] }}>
            <View style={{ gap: space[2] }}>
              <Txt variant="label" color={c.brand}>
                Step 3 of 4
              </Txt>
              <Txt variant="display">Your key is your wallet</Txt>
              <Txt variant="body" muted>
                Bond made an Ed25519 key on this device. It signs every message you send, and
                because Solana keys are Ed25519 too, it is also your Solana address.
              </Txt>
            </View>
            <Animated.View entering={enter.row(1)}>
              <Card glow="brand" style={{ gap: space[1], paddingVertical: space[5] }}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <Txt variant="label" faint>
                    Device identity
                  </Txt>
                  <VerifiedBadge state="verified" />
                </View>
                <Txt variant="mono" style={{ marginTop: space[2] }}>
                  {did ? truncateMiddle(did, 18, 6) : "Generating your identity…"}
                </Txt>
                <KeyLink />
                <Txt variant="label" faint>
                  Same key, as a Solana address
                </Txt>
                <Txt variant="mono" color={c.brand} style={{ marginTop: space[2] }}>
                  {address ? truncateMiddle(address, 10, 8) : "…"}
                </Txt>
              </Card>
            </Animated.View>
            <Txt variant="caption" faint style={{ lineHeight: 18 }}>
              Connect a Seeker wallet later and Seed Vault becomes the payer, bound to this key with
              one signed challenge.
            </Txt>
          </View>
        );
      default:
        return (
          <View style={{ flex: 1, justifyContent: "center", gap: space[6] }}>
            <View style={{ gap: space[2] }}>
              <Txt variant="label" color={c.brand}>
                Ready
              </Txt>
              <Txt variant="display">Start building your verified space</Txt>
            </View>
            <View style={{ gap: space[5] }}>
              <FeatureRow
                index={0}
                icon="shield-checkmark"
                tint={c.verified}
                soft={c.verifiedSoft}
                title="Every message signed"
                body="Verified on read, so a tampered or forged message never renders as authentic."
              />
              <FeatureRow
                index={1}
                icon="sparkles"
                tint={c.agent}
                soft={c.agentSoft}
                title="Agents as members"
                body="Mention @Bond and its tool calls and results stream into the thread."
              />
              <FeatureRow
                index={2}
                icon="cash"
                tint={c.brand}
                soft={c.brandSoft}
                title="Pay anyone in USDC"
                body="Signed through Mobile Wallet Adapter, settled on Solana devnet. No real funds."
              />
            </View>
          </View>
        );
    }
  };

  return (
    <Screen edges={["top", "bottom"]}>
      <AmbientGlow intensity={step === 0 ? 1 : 0.55} />
      <View style={{ flex: 1, paddingHorizontal: space[5], paddingTop: space[2], paddingBottom: space[4] }}>
        <View style={{ height: 40, justifyContent: "center", alignItems: "center", marginBottom: space[4] }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            {Array.from({ length: STEP_COUNT }).map((_, i) => (
              <ProgressPill key={i} state={i === step ? "active" : i < step ? "done" : "todo"} />
            ))}
          </View>
          {step > 0 ? (
            <Pressable
              onPress={() => go(step - 1)}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Back"
              style={{ position: "absolute", left: 0, top: 0, bottom: 0, justifyContent: "center", paddingRight: space[3] }}
            >
              <Ionicons name="chevron-back" size={24} color={c.textMuted} />
            </Pressable>
          ) : null}
        </View>

        <Animated.View key={step} entering={entering} exiting={exiting} style={{ flex: 1 }}>
          {renderStep()}
        </Animated.View>

        <View style={{ paddingTop: space[4] }}>
          <Button
            title={isLast ? "Enter Bond" : step === 0 ? "Get started" : "Continue"}
            variant="primary"
            onPress={isLast ? finish : () => go(step + 1)}
            loading={isLast ? busy : false}
          />
        </View>
      </View>
    </Screen>
  );
}
