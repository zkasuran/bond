// The skill detail screen. What the skill does, the tools it exposes, the permissions it
// asks for and the price, then the buy flow. The price and split render on any platform so
// a judge can read them anywhere; the signature step runs on an Android device with a
// connected Seeker wallet. Once bought, the transaction signature is shown as the proof of
// purchase. Built on Bond's tokens and ui components.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Linking, Pressable, ScrollView, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { PublicKey } from "@solana/web3.js";
import { Screen } from "@/components/ui/Screen";
import { Txt } from "@/components/ui/Text";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Badge";
import { useTokens } from "@/theme";
import { getConnection, SOLANA_CLUSTER } from "@/solana/config";
import { applySkrHolderDiscount, creatorSkrDiscountBps } from "@/solana/skr";
import { explorerTxUrl } from "@/solana/explorer";
import { useBond } from "@/state/store";
import { useWallet } from "@/solana/store";
import { WalletConnectButton, shortenAddress } from "@/solana/WalletConnectButton";
import { useSkills } from "@/skills/registry";
import { distributionLabel, formatPrice } from "@/skills/manifest";
import { executeSkillPurchase, quoteSkillPurchase } from "@/skills/purchase";

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

export default function MarketDetailScreen() {
  const { c, space } = useTokens();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const getSkill = useSkills((s) => s.getSkill);
  const load = useSkills((s) => s.load);
  const install = useSkills((s) => s.install);
  const entitlements = useSkills((s) => s.entitlements);

  const available = useWallet((s) => s.available);
  const address = useWallet((s) => s.connectedAddress);
  const authToken = useWallet((s) => s.authToken);
  const skr = useBond((s) => s.skr);
  const refreshSkr = useBond((s) => s.refreshSkr);

  const [buying, setBuying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // SKR is read live from mainnet, read-only. Optional-called so a store without it (tests)
    // never crashes the screen.
    const t = setTimeout(() => void refreshSkr?.(address ?? null), 0);
    return () => clearTimeout(t);
  }, [address, refreshSkr]);

  const skill = id ? getSkill(id) : undefined;
  const entitlement = skill ? entitlements[skill.id] : undefined;
  const installed = !!entitlement;

  // SKR holder perk. A holder gets a bounded, creator-set discount on the devnet-USDC price;
  // a non-holder gets none. The discount is applied by charging a discounted price, so the
  // purchase still settles in devnet USDC and no SKR is ever moved.
  const isHolder = skr?.isHolder ?? false;
  const skrPriceInUsdc = skr?.priceInUsdc ?? 0;
  const discount = useMemo(
    () =>
      skill ? applySkrHolderDiscount(skill.price.amount, isHolder, creatorSkrDiscountBps(skill.id)) : null,
    [skill, isHolder],
  );
  const purchaseSkill = useMemo(
    () =>
      skill && discount ? { ...skill, price: { ...skill.price, amount: discount.discountedUi } } : skill,
    [skill, discount],
  );
  const quote = useMemo(
    () => (purchaseSkill ? quoteSkillPurchase(purchaseSkill) : null),
    [purchaseSkill],
  );

  const onBuy = useCallback(async () => {
    if (!purchaseSkill) return;
    setError(null);
    if (!address || !authToken) {
      setError("Connect a wallet to buy this skill.");
      return;
    }
    setBuying(true);
    try {
      const connection = getConnection();
      const result = await executeSkillPurchase(connection, purchaseSkill, {
        buyer: new PublicKey(address),
        authToken,
      });
      await install(result.entitlement);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBuying(false);
    }
  }, [purchaseSkill, address, authToken, install]);

  if (!skill) {
    return (
      <Screen edges={["top"]}>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space[3], padding: space[4] }}>
          <Ionicons name="help-circle-outline" size={32} color={c.textFaint} />
          <Txt variant="body" muted>
            This skill is not in the catalog.
          </Txt>
          <Button title="Back to market" variant="secondary" onPress={() => router.replace("/market")} />
        </View>
      </Screen>
    );
  }

  const chargedUi = quote?.totalUi ?? skill.price.amount;
  const skrEquivalent = skrPriceInUsdc > 0 ? Number(chargedUi) / skrPriceInUsdc : null;
  const skrEquivalentLabel = skrEquivalent != null ? `≈ ${skrEquivalent.toFixed(2)} SKR` : "price unavailable";

  return (
    <Screen edges={["top"]}>
      <ScrollView
        contentContainerStyle={{ padding: space[4], paddingBottom: space[10], gap: space[6] }}
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

        <View style={{ gap: space[2] }}>
          <Txt variant="display">{skill.name}</Txt>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
            <Pill label={skill.category} />
            {isHolder ? <Pill label="SKR holder" tone="brand" /> : null}
            <Txt variant="caption" faint numberOfLines={1} style={{ flex: 1 }}>
              by {skill.author.displayName}
            </Txt>
          </View>
        </View>

        <View>
          <SectionLabel>What it does</SectionLabel>
          <Card>
            <Txt variant="body" muted style={{ lineHeight: 22 }}>
              {skill.description}
            </Txt>
          </Card>
        </View>

        <View>
          <SectionLabel>Tools</SectionLabel>
          <Card style={{ gap: space[3] }}>
            {skill.tools.map((t) => (
              <View key={t.name} style={{ gap: space[1] }}>
                <Txt variant="mono" color={c.brand}>
                  {t.name}
                </Txt>
                {t.description ? (
                  <Txt variant="caption" muted>
                    {t.description}
                  </Txt>
                ) : null}
              </View>
            ))}
          </Card>
        </View>

        <View>
          <SectionLabel>Permissions requested</SectionLabel>
          <Card style={{ gap: space[2] }}>
            {skill.permissions.map((p) => (
              <View key={p} style={{ flexDirection: "row", gap: space[2], alignItems: "flex-start" }}>
                <Ionicons name="key-outline" size={15} color={c.textMuted} style={{ marginTop: 2 }} />
                <Txt variant="caption" muted style={{ flex: 1 }}>
                  {p}
                </Txt>
              </View>
            ))}
          </Card>
        </View>

        <View>
          <SectionLabel>Price</SectionLabel>
          <Card style={{ gap: space[2] }}>
            <Row label="Price" value={formatPrice(skill.price)} valueColor={c.brand} />
            {discount && discount.bps > 0 ? (
              <>
                <Row
                  label={`SKR holder discount (${discount.bps / 100}%)`}
                  value={`-${discount.savingUi} USDC`}
                  valueColor={c.verified}
                />
                <Row label="You pay" value={`${discount.discountedUi} USDC`} valueColor={c.brand} />
              </>
            ) : null}
            <Row label="SKR equivalent" value={skrEquivalentLabel} />
            {quote ? (
              <>
                <Row label={`Creator (${100 - quote.platformFeeBps / 100}%)`} value={`${quote.authorUi} USDC`} />
                <Row label={`Platform fee (${quote.platformFeeBps / 100}%)`} value={`${quote.platformUi} USDC`} />
              </>
            ) : null}
            <View style={{ height: 1, backgroundColor: c.border, marginVertical: space[1] }} />
            <Row label="Delivery" value={distributionLabel(skill.distribution)} />
            {skill.endpoint ? <Row label="Endpoint" value={skill.endpoint} /> : null}
            <Txt variant="caption" faint>
              Paid in one atomic transaction on Solana devnet. The creator gets their cut in the same
              transaction the platform gets its fee, together or not at all.
            </Txt>
            <Txt variant="caption" faint>
              SKR holdings and the SKR equivalent are read live from Solana mainnet. No SKR is
              moved. The holder discount lowers the devnet USDC price, which still settles in
              devnet USDC.
            </Txt>
          </Card>
        </View>

        <View>
          <SectionLabel>{installed ? "Owned" : "Buy"}</SectionLabel>
          <Card style={{ gap: space[3] }}>
            {installed ? (
              <>
                <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
                  <Ionicons name="checkmark-circle" size={18} color={c.verified} />
                  <Txt variant="callout" color={c.verified} style={{ flex: 1 }}>
                    Installed. Your agent can call this skill.
                  </Txt>
                </View>
                {entitlement?.signature ? (
                  <View style={{ gap: space[1] }}>
                    <Txt variant="mono" muted selectable>
                      Proof of purchase: {shortenAddress(entitlement.signature, 8, 8)}
                    </Txt>
                    <Pressable
                      onPress={() =>
                        void Linking.openURL(
                          explorerTxUrl(entitlement.signature as string, SOLANA_CLUSTER),
                        ).catch(() => {})
                      }
                      hitSlop={6}
                      accessibilityRole="link"
                      style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
                    >
                      <Ionicons name="open-outline" size={13} color={c.brand} />
                      <Txt variant="caption" color={c.brand}>View on Solana Explorer (devnet)</Txt>
                    </Pressable>
                  </View>
                ) : null}
              </>
            ) : (
              <>
                <WalletConnectButton />
                {available ? (
                  <Button
                    title={`Buy for ${formatPrice((purchaseSkill ?? skill).price)}`}
                    variant="primary"
                    loading={buying}
                    disabled={!address}
                    onPress={() => void onBuy()}
                    left={<Ionicons name="cart" size={16} color={c.onBrand} />}
                  />
                ) : (
                  <Txt variant="caption" faint>
                    Buying settles on an Android device with a connected Seeker wallet. The price and
                    the split above are live everywhere.
                  </Txt>
                )}
                <Txt variant="caption" faint>
                  You approve the payment with your device protection before it signs. Devnet USDC, no
                  real funds.
                </Txt>
              </>
            )}
            {error ? (
              <Txt variant="caption" color={c.tampered}>
                {error}
              </Txt>
            ) : null}
          </Card>
        </View>
      </ScrollView>
    </Screen>
  );
}
