// LockGate must keep its children mounted while the lock screen is up. The lock is an overlay,
// not a swap. An earlier build replaced the whole subtree with the lock screen, which unmounted
// the navigator while the root layout was still routing (its launch redirect fires
// router.replace), and React Navigation then looped reconciling a route against a navigator that
// was gone, tripping "Maximum update depth exceeded". This test fails if the overlay ever turns
// back into a replacement: it checks the sentinel child is still in the tree while the lock UI
// shows, and that the render settles instead of looping.
import TestRenderer from "react-test-renderer";
import { View } from "react-native";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));

jest.mock("@/components/ui/Screen", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { Screen: ({ children }: { children: unknown }) => React.createElement(View, null, children) };
});

jest.mock("@/components/ui/Text", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { Txt: ({ children }: { children: unknown }) => React.createElement(Text, null, children) };
});

jest.mock("@/components/ui/Button", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { Button: ({ title }: { title: string }) => React.createElement(Text, null, title) };
});

jest.mock("../PinPad", () => ({ PinSheet: () => null }));

// A guarded openApp policy, the state after a user turns the app lock on. loadProtectionPolicy
// resolves it so the gate takes the locked path on mount.
const GUARDED = {
  methods: { openApp: "biometric", runSkill: "none", spend: "biometric", unlockKey: "biometric" },
  spendThresholdUsdc: 1,
  reauthWindowSec: 60,
};
jest.mock("../policy", () => ({
  DEFAULT_POLICY: GUARDED,
  loadProtectionPolicy: jest.fn(async () => GUARDED),
  saveProtectionPolicy: jest.fn(async (p: unknown) => p),
}));

// The gate denies with no_pin (no sensor and no PIN, the web and fresh-device case), so the lock
// stays up. The async resolve is what used to re-arm the loop, so holding here is the real test.
jest.mock("../gate", () => ({
  authorizePolicyChange: jest.fn(async () => ({ ok: true, outcome: "not_required" })),
  getLastAuthAt: jest.fn(() => undefined),
  isWithinGrace: jest.fn(() => false),
  markPinEnrolledInSession: jest.fn(),
  requireAuth: jest.fn(async () => ({ ok: false, outcome: "no_pin", trigger: "openApp", method: "biometric" })),
  setPin: jest.fn(async () => {}),
  setPinPrompter: jest.fn(),
}));

import { LockGate } from "../LockGate";

const tick = () => new Promise((r) => setImmediate(r));

it("renders the lock overlay with the app children still mounted underneath", async () => {
  let tree: TestRenderer.ReactTestRenderer;
  await TestRenderer.act(async () => {
    tree = TestRenderer.create(
      <LockGate>
        <View testID="app-children" />
      </LockGate>,
    );
    await tick();
    await tick();
  });

  const root = tree!.root;
  const { Text } = require("react-native");
  // The lock UI is up.
  const texts = root.findAllByType(Text).map((n) => n.props.children);
  expect(texts).toContain("Bond is locked");
  // and the children were not unmounted to show it (react-test-renderer surfaces both the
  // component node and its host node, so the count is the presence, not a single element).
  expect(root.findAllByProps({ testID: "app-children" }).length).toBeGreaterThan(0);

  TestRenderer.act(() => tree!.unmount());
});
