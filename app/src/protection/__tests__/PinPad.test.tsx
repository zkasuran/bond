// The PIN sheet must show a new digit layout on every entry: each time it opens and after each
// submit (the confirm step, a retry after a wrong PIN).
import TestRenderer from "react-test-renderer";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("@/components/ui/Text", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { Txt: ({ children }: { children: unknown }) => React.createElement(Text, null, children) };
});
jest.mock("@/components/ui/Button", () => {
  const React = require("react");
  const { Pressable, Text } = require("react-native");
  return {
    Button: ({ title, onPress }: { title: string; onPress?: () => void }) =>
      React.createElement(Pressable, { onPress, accessibilityLabel: `btn:${title}` }, React.createElement(Text, null, title)),
  };
});

import { PinSheet } from "../PinPad";

function digitOrder(root: TestRenderer.ReactTestInstance): string[] {
  return root
    .findAll((n) => typeof n.props.accessibilityLabel === "string" && n.props.accessibilityLabel.startsWith("Digit ") && typeof n.type !== "string")
    .map((n) => n.props.accessibilityLabel.slice(6))
    .filter((d, i, a) => a.indexOf(d) === i);
}

function press(root: TestRenderer.ReactTestInstance, label: string) {
  const node = root.findAll((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === "function")[0]!;
  TestRenderer.act(() => node.props.onPress());
}

it("reshuffles the digits after every submit", () => {
  const onSubmit = jest.fn();
  let tree!: TestRenderer.ReactTestRenderer;
  TestRenderer.act(() => {
    tree = TestRenderer.create(<PinSheet visible title="Choose a PIN" onSubmit={onSubmit} onCancel={() => {}} />);
  });
  const layouts: string[] = [];
  for (let round = 0; round < 4; round++) {
    const order = digitOrder(tree.root);
    expect([...order].sort()).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    layouts.push(order.join(""));
    for (const d of ["1", "2", "3", "4"]) press(tree.root, `Digit ${d}`);
    press(tree.root, "btn:Confirm");
  }
  // The PIN typed is the same digits each round, whatever their positions.
  expect(onSubmit.mock.calls.map((c) => c[0])).toEqual(["1234", "1234", "1234", "1234"]);
  // Four layouts, at least three distinct (an accidental repeat is ~1 in 3.6 million).
  expect(new Set(layouts).size).toBeGreaterThanOrEqual(3);
  expect(layouts).not.toContain("1234567890");
  TestRenderer.act(() => tree.unmount());
});
