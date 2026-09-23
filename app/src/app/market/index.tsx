// The Skills Market browse screen. A creator publishes a skill and gets paid on chain in
// USDC; a buyer installs one so their agent can call it in a room. This screen lists the
// catalog with price, author and category, filters to what you already own and opens a
// detail screen to buy. Built on Bond's tokens and ui components.
import { useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { Screen } from "@/components/ui/Screen";
import { Txt } from "@/components/ui/Text";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Badge";
import { useTokens } from "@/theme";
import { useSkills } from "@/skills/registry";
import { formatPrice, type Skill } from "@/skills/manifest";

type Filter = "all" | "installed";

export default function MarketScreen() {
  const { c, space } = useTokens();
  const router = useRouter();
  const catalog = useSkills((s) => s.catalog);
  const entitlements = useSkills((s) => s.entitlements);
  const load = useSkills((s) => s.load);

  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    void load();
  }, [load]);

  const skills = filter === "installed" ? catalog.filter((s) => !!entitlements[s.id]) : catalog;
  const ownedCount = catalog.filter((s) => !!entitlements[s.id]).length;

  return (
    <Screen edges={["top"]}>
      <ScrollView
        contentContainerStyle={{ padding: space[4], paddingBottom: space[10], gap: space[5] }}
        showsVerticalScrollIndicator={false}
      >
        {router.canGoBack() ? (
          <Pressable
            onPress={() => router.back()}
            hitSlop={12}
            style={{ flexDirection: "row", alignItems: "center", gap: space[1] }}
          >
            <Ionicons name="chevron-back" size={20} color={c.brand} />
            <Txt variant="callout" color={c.brand}>
              Back
            </Txt>
          </Pressable>
        ) : null}

        <View style={{ gap: space[1] }}>
          <Txt variant="display">Skills Market</Txt>
          <Txt variant="body" muted>
            Publish a skill, get paid in USDC. Install a skill, your agent can call it.
          </Txt>
        </View>

        <View style={{ flexDirection: "row", gap: space[2] }}>
          <FilterTab label="All" active={filter === "all"} onPress={() => setFilter("all")} />
          <FilterTab
            label={`Installed${ownedCount ? ` (${ownedCount})` : ""}`}
            active={filter === "installed"}
            onPress={() => setFilter("installed")}
          />
        </View>

        {skills.length === 0 ? (
          <Card style={{ alignItems: "center", gap: space[2], paddingVertical: space[7] }}>
            <Ionicons name="pricetags-outline" size={28} color={c.textFaint} />
            <Txt variant="callout" muted>
              No skills installed yet
            </Txt>
            <Txt variant="caption" faint style={{ textAlign: "center" }}>
              Browse the catalog and buy one to see it here.
            </Txt>
          </Card>
        ) : (
          <View style={{ gap: space[3] }}>
            {skills.map((skill) => (
              <SkillCard
                key={skill.id}
                skill={skill}
                installed={!!entitlements[skill.id]}
                onPress={() => router.push(`/market/${skill.id}`)}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

function FilterTab({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const { c, space, radius } = useTokens();
  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingVertical: space[2],
        paddingHorizontal: space[4],
        borderRadius: radius.pill,
        backgroundColor: active ? c.brand : c.surfaceAlt,
      }}
    >
      <Txt variant="callout" color={active ? "#FFFFFF" : c.textMuted}>
        {label}
      </Txt>
    </Pressable>
  );
}

function SkillCard({
  skill,
  installed,
  onPress,
}: {
  skill: Skill;
  installed: boolean;
  onPress: () => void;
}) {
  const { c, space } = useTokens();
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
      <Card style={{ gap: space[3] }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space[3] }}>
          <View style={{ flex: 1, gap: space[1] }}>
            <Txt variant="heading" numberOfLines={1}>
              {skill.name}
            </Txt>
            <Txt variant="caption" muted numberOfLines={2}>
              {skill.description}
            </Txt>
          </View>
          {installed ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space[1] }}>
              <Ionicons name="checkmark-circle" size={16} color={c.verified} />
              <Txt variant="caption" color={c.verified}>
                Installed
              </Txt>
            </View>
          ) : (
            <Txt variant="callout" color={c.brand}>
              {formatPrice(skill.price)}
            </Txt>
          )}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
          <Pill label={skill.category} />
          <Txt variant="caption" faint numberOfLines={1} style={{ flex: 1 }}>
            by {skill.author.displayName}
          </Txt>
        </View>
      </Card>
    </Pressable>
  );
}
