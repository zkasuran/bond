// Turning the app lock on from inside the app (onboarding, Protection settings) must not lock the
// owner out on the spot: the session they are using is already trusted, so the lock is armed for
// the next open. A launch with a stored guarded policy must still prompt.
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

const OPEN = {
  methods: { openApp: "none", runSkill: "none", spend: "biometric", unlockKey: "biometric" },
  spendThresholdUsdc: 1,
  reauthWindowSec: 60,
};
const GUARDED = { ...OPEN, methods: { ...OPEN.methods, openApp: "pin" } };
const mockLoad = jest.fn(async () => OPEN);
jest.mock("../policy", () => ({
  DEFAULT_POLICY: {
    methods: { openApp: "none", runSkill: "none", spend: "biometric", unlockKey: "biometric" },
    spendThresholdUsdc: 1,
    reauthWindowSec: 60,
  },
  loadProtectionPolicy: () => mockLoad(),
  saveProtectionPolicy: jest.fn(async (p: unknown) => p),
}));
const mockRequireAuth = jest.fn(async () => ({ ok: false, outcome: "cancelled", trigger: "openApp", method: "pin" }));
jest.mock("../gate", () => ({
  authorizePolicyChange: jest.fn(async () => ({ ok: true, outcome: "not_required" })),
  getLastAuthAt: jest.fn(() => undefined),
  isWithinGrace: jest.fn(() => false),
  markPinEnrolledInSession: jest.fn(),
  requireAuth: () => mockRequireAuth(),
  setPin: jest.fn(async () => {}),
  setPinPrompter: jest.fn(),
}));

import { LockGate, useProtection } from "../LockGate";

const tick = () => new Promise((r) => setImmediate(r));

function texts(tree: TestRenderer.ReactTestRenderer): unknown[] {
  const { Text } = require("react-native");
  return tree.root.findAllByType(Text).map((n) => n.props.children);
}

beforeEach(() => {
  mockRequireAuth.mockClear();
  useProtection.setState({ ready: false, policy: OPEN as never });
});

it("arms the lock without prompting when it is turned on during the session", async () => {
  mockLoad.mockResolvedValueOnce(OPEN);
  let tree!: TestRenderer.ReactTestRenderer;
  await TestRenderer.act(async () => {
    tree = TestRenderer.create(
      <LockGate>
        <View testID="app" />
      </LockGate>,
    );
    await tick();
  });
  expect(texts(tree)).not.toContain("Bond is locked");

  await TestRenderer.act(async () => {
    await useProtection.getState().setMethod("openApp", "pin");
    await tick();
  });
  expect(useProtection.getState().policy.methods.openApp).toBe("pin");
  expect(texts(tree)).not.toContain("Bond is locked");
  expect(mockRequireAuth).not.toHaveBeenCalled();
  TestRenderer.act(() => tree.unmount());
});

it("still prompts at launch when the stored policy is already guarded", async () => {
  mockLoad.mockResolvedValueOnce(GUARDED);
  let tree!: TestRenderer.ReactTestRenderer;
  await TestRenderer.act(async () => {
    tree = TestRenderer.create(
      <LockGate>
        <View testID="app" />
      </LockGate>,
    );
    await tick();
    await tick();
  });
  expect(texts(tree)).toContain("Bond is locked");
  expect(mockRequireAuth).toHaveBeenCalled();
  TestRenderer.act(() => tree.unmount());
});
