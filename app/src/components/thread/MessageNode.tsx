import { memo } from "react";
import { Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { BondNode } from "@/model/node";
import { isType } from "@/model/messages";
import type { RenderRow } from "@/model/thread";
import { verifyNode } from "@/identity/sign";
import { useTokens } from "@/theme";
import { Avatar } from "@/components/ui/Avatar";
import { VerifiedBadge } from "@/components/ui/Badge";
import { Txt } from "@/components/ui/Text";

function timeOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

function bodyText(node: BondNode): string {
  if (isType(node, "text")) return node.payload.body;
  if (isType(node, "tool_call")) return `called ${node.payload.name}`;
  if (isType(node, "tool_result")) return "tool result";
  return `[${node.type}]`;
}

export const MessageNode = memo(function MessageNode({
  row,
  streaming,
  onReply,
  onToggleCollapse,
}: {
  row: RenderRow;
  streaming: boolean;
  onReply: (node: BondNode) => void;
  onToggleCollapse: (nodeId: string) => void;
}) {
  const { c, space, radius } = useTokens();
  const node = row.node;
  const isAgent = node.author.kind === "agent";
  const verify = verifyNode(node);
  const text = bodyText(node);
  const indent = row.depth * 16;

  return (
    <View style={{ flexDirection: "row", paddingRight: space[4], paddingVertical: space[2] }}>
      {/* depth rails */}
      <View style={{ flexDirection: "row", width: indent }}>
        {Array.from({ length: row.depth }).map((_, i) => (
          <View
            key={i}
            style={{ width: 16, alignItems: "center" }}
          >
            <View style={{ width: 1.5, flex: 1, backgroundColor: c.border, borderRadius: 1 }} />
          </View>
        ))}
      </View>

      <View style={{ paddingLeft: space[3] }}>
        <Avatar did={node.author.did} name={node.author.displayName} kind={node.author.kind} size={34} />
      </View>

      <View style={{ flex: 1, paddingLeft: space[3], gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space[2] }}>
          <Txt variant="callout" color={isAgent ? c.agent : c.text}>
            {node.author.displayName}
          </Txt>
          {isAgent ? <Txt variant="caption" faint>agent</Txt> : null}
          <VerifiedBadge state={verify} />
          <Txt variant="caption" faint>{timeOf(node.createdAt)}</Txt>
        </View>

        {streaming && text.length === 0 ? (
          <Txt variant="body" muted>thinking…</Txt>
        ) : (
          <Txt variant="body">
            {text}
            {streaming ? <Txt variant="body" color={c.brand}> ▍</Txt> : null}
          </Txt>
        )}

        <View style={{ flexDirection: "row", alignItems: "center", gap: space[4], marginTop: 2 }}>
          <Pressable
            onPress={() => onReply(node)}
            hitSlop={8}
            style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
          >
            <Ionicons name="return-down-forward" size={13} color={c.textFaint} />
            <Txt variant="caption" faint>Reply</Txt>
          </Pressable>
          {row.hiddenCount > 0 ? (
            <Pressable
              onPress={() => onToggleCollapse(node.id)}
              hitSlop={8}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                backgroundColor: c.brandSoft,
                paddingHorizontal: space[2],
                paddingVertical: 2,
                borderRadius: radius.pill,
              }}
            >
              <Ionicons name="chevron-down" size={13} color={c.brand} />
              <Txt variant="caption" color={c.brand}>
                {row.hiddenCount} {row.hiddenCount === 1 ? "reply" : "replies"}
              </Txt>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
});
