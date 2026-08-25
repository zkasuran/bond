// Bond onboarding. A four step, single-file flow using local step state, no extra routes.
// It sells the promise, learns a little about you, then makes the core idea concrete by
// showing your real device identity and the signature it puts on every message. Light and
// dark are both first class. See DESIGN.md sec 6 and 7.
import { useState } from "react";
import { Animated, Platform, Pressable, View } from "react-native";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { Screen } from "@/components/ui/Screen";
import { Txt } from "@/components/ui/Text";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { VerifiedBadge } from "@/components/ui/Badge";
import { useBond } from "@/state/store";
import { useTokens } from "@/theme";

const STEP_COUNT = 4;

/** Shorten a long identifier so both ends stay readable, keeping the value concrete. */
function truncateMiddle(value: string, head = 16, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function tap() {
  if (Platform.OS !== "web") void Haptics.selectionAsync().catch(() => {});
}

/** The step indicator. The current step reads as a wide pill, done steps stay filled. */
function ProgressDots({ step }: { step: number }) {
  const { c, radius } = useTokens();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      {Array.from({ length: STEP_COUNT }).map((_, i) => {
        const active = i === step;
        const done = i < step;
        return (
          <View
            key={i}
            style={{
              width: active ? 22 : 7,
              height: 7,
              borderRadius: radius.pill,
              backgroundColor: active || done ? c.brand : c.borderStrong,
              opacity: done ? 0.5 : 1,
            }}
          />
        );
      })}
    </View>
  );
}
/** The core Bond symbol: a human circle bonded to an agent rounded square, the same two
 *  shapes the Avatar uses, so the mark and the app speak one language. */
function BondMark({ size = 64 }: { size?: number }) {
  const { c } = useTokens();
  const overlap = Math.round(size * 0.28);
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: c.human,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Ionicons name="person" size={size * 0.44} color="#FFFFFF" />
      </View>
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size * 0.3,
          marginLeft: -overlap,
          backgroundColor: c.agent,
          borderWidth: 3,
          borderColor: c.bg,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Ionicons name="hardware-chip" size={size * 0.44} color="#FFFFFF" />
      </View>
    </View>
  );
}

/** A soft tile behind a single glyph, used for the signing and commit moments. */
function GlyphTile({
  icon,
  tint,
  soft,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  tint: string;
  soft: string;
}) {
  const { radius } = useTokens();
  return (
    <View
      style={{
        width: 76,
        height: 76,
        borderRadius: radius.xl,
        backgroundColor: soft,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Ionicons name={icon} size={38} color={tint} />
    </View>
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
  icon: keyof typeof Ionicons.glyphMap;
  selected: boolean;
  onPress: () => void;
}) {
  const { c, radius, space } = useTokens();
  return (
    <Pressable
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: space[2],
        paddingVertical: space[3],
        paddingHorizontal: space[4],
        borderRadius: radius.pill,
        borderWidth: 1.5,
        borderColor: selected ? c.brand : c.border,
        backgroundColor: selected ? c.brandSoft : c.surface,
        opacity: pressed ? 0.9 : 1,
      })}
    >
      <Ionicons
        name={selected ? "checkmark-circle" : icon}
        size={18}
        color={selected ? c.brand : c.textMuted}
      />
      <Txt variant="callout" color={selected ? c.brand : c.text}>
        {label}
      </Txt>
    </Pressable>
  );
}

type Who = "solo" | "team";
type Connect = "assistant" | "own";

export default function Onboarding() {
  const { c, space } = useTokens();
  const router = useRouter();
  const identity = useBond((s) => s.identity);

  const [step, setStep] = useState(0);
  const [who, setWho] = useState<Who | null>(null);
  const [connect, setConnect] = useState<Connect | null>(null);
  const [busy, setBusy] = useState(false);

  const [opacity] = useState(() => new Animated.Value(1));
  const [translateX] = useState(() => new Animated.Value(0));

  const animateTo = (nextStep: number) => {
    const dir = nextStep > step ? 1 : -1;
    Animated.parallel([
      Animated.timing(opacity, { toValue: 0, duration: 130, useNativeDriver: true }),
      Animated.timing(translateX, { toValue: -dir * 26, duration: 130, useNativeDriver: true }),
    ]).start(() => {
      setStep(nextStep);
      translateX.setValue(dir * 26);
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.spring(translateX, {
          toValue: 0,
          friction: 9,
          tension: 80,
          useNativeDriver: true,
        }),
      ]).start();
    });
  };

  const back = () => {
    if (step === 0) return;
    tap();
    animateTo(step - 1);
  };

  const next = () => {
    tap();
    animateTo(step + 1);
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
  const isLast = step === STEP_COUNT - 1;

  const renderStep = () => {
    switch (step) {
      case 0:
        return (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space[6] }}>
            <BondMark size={72} />
            <View style={{ gap: space[3], alignItems: "center" }}>
              <Txt
                variant="caption"
                color={c.brand}
                style={{ letterSpacing: 1, textTransform: "uppercase" }}
              >
                Welcome to Bond
              </Txt>
              <Txt variant="display" style={{ textAlign: "center" }}>
                Bond
              </Txt>
              <Txt variant="body" muted style={{ textAlign: "center", maxWidth: 300 }}>
                Bond is the messaging app for humans and agents, together.
              </Txt>
            </View>
          </View>
        );
      case 1:
        return (
          <View style={{ flex: 1, justifyContent: "center", gap: space[6] }}>
            <View style={{ gap: space[2] }}>
              <Txt variant="title">A little about you</Txt>
              <Txt variant="body" muted>
                This tunes your first room. Change any of it later or skip ahead.
              </Txt>
            </View>
            <View style={{ gap: space[3] }}>
              <Txt variant="callout" muted>
                Who is in your rooms?
              </Txt>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[2] }}>
                <Chip
                  label="Just me"
                  icon="person-outline"
                  selected={who === "solo"}
                  onPress={() => setWho(who === "solo" ? null : "solo")}
                />
                <Chip
                  label="A team"
                  icon="people-outline"
                  selected={who === "team"}
                  onPress={() => setWho(who === "team" ? null : "team")}
                />
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
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space[5] }}>
            <GlyphTile icon="shield-checkmark" tint={c.brand} soft={c.brandSoft} />
            <View style={{ gap: space[3], alignItems: "center" }}>
              <Txt variant="title" style={{ textAlign: "center" }}>
                Every message is signed
              </Txt>
              <Txt variant="body" muted style={{ textAlign: "center", maxWidth: 320 }}>
                Bond signs each message with a key that lives only on this device. Anyone in
                the room can check it is really you and that nothing was changed.
              </Txt>
            </View>
            <Card style={{ width: "100%", gap: space[3] }}>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <Txt
                  variant="caption"
                  faint
                  style={{ letterSpacing: 0.5, textTransform: "uppercase" }}
                >
                  Your device identity
                </Txt>
                <VerifiedBadge state="verified" />
              </View>
              <Txt variant="mono">{did ? truncateMiddle(did) : "Generating your identity…"}</Txt>
            </Card>
          </View>
        );
      default:
        return (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space[6] }}>
            <BondMark size={72} />
            <View style={{ gap: space[3], alignItems: "center" }}>
              <Txt variant="display" style={{ textAlign: "center", maxWidth: 320 }}>
                Start building your verified space
              </Txt>
              <Txt variant="body" muted style={{ textAlign: "center", maxWidth: 300 }}>
                Open a room, bring in people, add your agents. Every voice verified.
              </Txt>
            </View>
          </View>
        );
    }
  };
  return (
    <Screen edges={["top", "bottom"]}>
      <View
        style={{
          flex: 1,
          paddingHorizontal: space[5],
          paddingTop: space[2],
          paddingBottom: space[4],
        }}
      >
        <View
          style={{
            height: 40,
            justifyContent: "center",
            alignItems: "center",
            marginBottom: space[4],
          }}
        >
          <ProgressDots step={step} />
          {step > 0 ? (
            <Pressable
              onPress={back}
              hitSlop={12}
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                bottom: 0,
                justifyContent: "center",
                paddingRight: space[3],
              }}
            >
              <Ionicons name="chevron-back" size={24} color={c.textMuted} />
            </Pressable>
          ) : null}
        </View>

        <Animated.View style={{ flex: 1, opacity, transform: [{ translateX }] }}>
          {renderStep()}
        </Animated.View>

        <View style={{ paddingTop: space[4] }}>
          <Button
            title={isLast ? "Enter Bond" : "Continue"}
            variant="primary"
            onPress={isLast ? finish : next}
            loading={isLast ? busy : false}
          />
        </View>
      </View>
    </Screen>
  );
}
