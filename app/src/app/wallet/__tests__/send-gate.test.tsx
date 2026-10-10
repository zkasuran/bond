// The wallet Send flow must route through the spend gate before it builds or signs anything.
// WalletScreen is rendered with its solana and protection deps mocked, then the Send button
// is pressed: a denied gate must stop the transfer, an allowed gate must let it build.
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("expo-haptics", () => ({ selectionAsync: jest.fn() }));
// The real expo-router pulls ESM-only navigation packages jest cannot transform here. The room
// and bridge route modules only use these two hooks at render, which these tests never trigger.
// Stub them so the pure helpers and the exported fallback import cleanly.
jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => false }),
}));
jest.mock("@/components/ui/Screen", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { Screen: ({ children }: { children: unknown }) => React.createElement(View, null, children) };
});

jest.mock("@solana/web3.js", () => ({
  PublicKey: class {
    v: string;
    constructor(v: string) {
      if (!v) throw new Error("empty address");
      this.v = v;
    }
  },
}));

jest.mock("@/solana/config", () => ({
  getConnection: jest.fn(() => ({ getBalance: jest.fn(async () => 0) })),
  LAMPORTS_PER_SOL: 1_000_000_000,
  SOLANA_CLUSTER: "devnet",
  SOL_DECIMALS: 9,
  USDC_DECIMALS: 6,
  USDC_MAINNET_MINT: "USDCmain",
  WSOL_MINT: "WSOL",
}));

jest.mock("@/solana/usdc", () => ({
  toBaseUnits: (s: string, d = 6) => BigInt(Math.round(Number(s) * 10 ** d)),
  fromBaseUnits: (b: bigint, d = 6) => String(Number(b) / 10 ** d),
  buildUsdcTransfer: jest.fn(async () => ({
    transaction: { recentBlockhash: "HASH" },
    amountBaseUnits: 2_000_000n,
    lastValidBlockHeight: 1,
  })),
  getUsdcBalance: jest.fn(async () => ({ amountBaseUnits: 0n, uiAmount: "0" })),
}));

jest.mock("@/solana/swap", () => ({
  getQuote: jest.fn(),
  summarizeQuote: jest.fn(),
}));

jest.mock("@/solana/wallet", () => ({
  signAndSendTransaction: jest.fn(async () => "SIGNATURE"),
}));

jest.mock("@/solana/store", () => {
  const state = {
    available: true,
    connecting: false,
    connectedAddress: "WALLETaddress1111",
    addressBase64: "YmFzZTY0",
    authToken: "token",
    label: "Seeker",
    binding: { walletAddress: "WALLETaddress1111" },
    error: null,
    connect: jest.fn(),
    disconnect: jest.fn(),
    bindIdentity: jest.fn(),
    loadStoredBinding: jest.fn(async () => {}),
  };
  return { useWallet: (sel: (s: typeof state) => unknown) => sel(state), __state: state };
});

jest.mock("@/state/store", () => ({
  useBond: (sel: (s: { identity: unknown }) => unknown) =>
    sel({ identity: { did: "did:key:zMe", displayName: "Me", kind: "human" } }),
}));

jest.mock("@/protection/gate", () => ({ requireAuth: jest.fn() }));

import TestRenderer from "react-test-renderer";
import { Component, type ReactNode } from "react";
import { Text, TextInput, View } from "react-native";
import { ulid } from "ulidx";
import WalletScreen from "../index";
import { Button } from "@/components/ui/Button";
import { requireAuth } from "@/protection/gate";
import { buildUsdcTransfer } from "@/solana/usdc";
import { signAndSendTransaction } from "@/solana/wallet";
import { normalizeRoomId, ErrorBoundary as RoomErrorBoundary } from "../../room/[roomId]/index";
import { validateBridgeBaseUrl } from "../../bridge/connect";

const tick = () => new Promise((r) => setImmediate(r));

let mounted: TestRenderer.ReactTestRenderer | null = null;

async function renderAndSend(): Promise<void> {
  let tree: TestRenderer.ReactTestRenderer;
  await TestRenderer.act(async () => {
    tree = TestRenderer.create(<WalletScreen />);
    mounted = tree;
    await tick();
  });
  const root = tree!.root;
  const inputs = root.findAllByType(TextInput);
  await TestRenderer.act(async () => {
    inputs[0].props.onChangeText("RECIPIENTaddress2222");
    inputs[1].props.onChangeText("2");
    await tick();
  });
  const sendButton = root.findAllByType(Button).find((b) => b.props.title === "Send USDC");
  await TestRenderer.act(async () => {
    sendButton!.props.onPress();
    await tick();
    await tick();
    await tick();
  });
}

// Unmount between tests so no render or pending effect from one test can call into the
// next test's mocks.
afterEach(() => {
  TestRenderer.act(() => mounted?.unmount());
  mounted = null;
});

beforeEach(() => {
  (buildUsdcTransfer as jest.Mock).mockClear();
  (signAndSendTransaction as jest.Mock).mockClear();
  (requireAuth as jest.Mock).mockReset();
});

describe("wallet Send routed through the spend gate", () => {
  it("stops the transfer when the gate denies", async () => {
    (requireAuth as jest.Mock).mockResolvedValue({ ok: false, outcome: "no_pin", trigger: "spend", method: "biometric" });
    await renderAndSend();
    expect(requireAuth).toHaveBeenCalledWith("spend", { amountUsdc: 2 });
    expect(buildUsdcTransfer).not.toHaveBeenCalled();
    expect(signAndSendTransaction).not.toHaveBeenCalled();
  });

  it("builds and signs the transfer when the gate allows", async () => {
    (requireAuth as jest.Mock).mockResolvedValue({ ok: true, outcome: "granted", trigger: "spend", method: "biometric" });
    await renderAndSend();
    expect(requireAuth).toHaveBeenCalledWith("spend", { amountUsdc: 2 });
    expect(buildUsdcTransfer).toHaveBeenCalledTimes(1);
    expect(signAndSendTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("identity binding row", () => {
  const walletState = (jest.requireMock("@/solana/store") as { __state: { binding: { walletAddress: string } } }).__state;
  const texts = (tree: TestRenderer.ReactTestRenderer) =>
    tree.root.findAll((n) => typeof n.props.children === "string" || Array.isArray(n.props.children))
      .map((n) => [].concat(n.props.children).filter((x) => typeof x === "string").join(""));

  async function render() {
    let tree: TestRenderer.ReactTestRenderer;
    await TestRenderer.act(async () => {
      tree = TestRenderer.create(<WalletScreen />);
      mounted = tree;
      await tick();
    });
    return tree!;
  }

  it("shows bound only when the binding is for the connected wallet", async () => {
    walletState.binding = { walletAddress: "WALLETaddress1111" };
    const all = texts(await render()).join("|");
    expect(all).toMatch(/Bound to/);
    expect(all).not.toMatch(/not this wallet/);
  });

  it("flags a binding for a different wallet and offers to re-bind", async () => {
    walletState.binding = { walletAddress: "OTHERwallet999999" };
    const tree = await render();
    expect(texts(tree).join("|")).toMatch(/not this wallet/);
    expect(tree.root.findAllByType(Button).some((b) => b.props.title === "Bind this wallet instead")).toBe(true);
    walletState.binding = { walletAddress: "WALLETaddress1111" };
  });
});

// F18 LOW: a deep-link roomId is untrusted. It is normalized before it can drive the room
// screen's auto-subscribe, so a duplicate-param array or a malformed id never reaches the
// sync socket. This also pins the INFO confirmation that route params fail closed.
describe("roomId deep-link normalization fails closed", () => {
  it("accepts a well-formed room id, including a real ulid", () => {
    const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    expect(normalizeRoomId(id)).toBe(id);
    expect(normalizeRoomId(`  ${id}  `)).toBe(id);
    const fresh = ulid();
    expect(normalizeRoomId(fresh)).toBe(fresh);
  });

  it("collapses a duplicate-param array to a valid first value", () => {
    const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    expect(normalizeRoomId([id, "evil"])).toBe(id);
  });

  it("rejects a malformed, hostile or empty id so no socket opens", () => {
    expect(normalizeRoomId(undefined)).toBe("");
    expect(normalizeRoomId("")).toBe("");
    expect(normalizeRoomId("   ")).toBe("");
    expect(normalizeRoomId("../../etc/passwd")).toBe("");
    expect(normalizeRoomId("not-a-ulid")).toBe("");
    expect(normalizeRoomId("01ARZ3NDEKTSV4RRFFQ69G5FA")).toBe(""); // 25 chars, too short
    expect(normalizeRoomId("01ILOU3NDEKTSV4RRFFQ69G5FA")).toBe(""); // excluded letters I L O U
    expect(normalizeRoomId(["evil", "01ARZ3NDEKTSV4RRFFQ69G5FAV"])).toBe(""); // bad first element
  });
});

// F18 LOW: the bridge base URL carries the user's API key to a host. It must be validated
// before the key is attached: https for any remote host, http only for loopback, no junk
// scheme and no cloud metadata address.
describe("bridge base URL validation", () => {
  it("accepts https anywhere and http only on loopback", () => {
    expect(validateBridgeBaseUrl("https://api.example.com/v1")).toEqual({ ok: true, url: "https://api.example.com/v1" });
    expect(validateBridgeBaseUrl("  https://api.example.com/v1  ")).toEqual({ ok: true, url: "https://api.example.com/v1" });
    expect(validateBridgeBaseUrl("http://localhost:11434/v1").ok).toBe(true);
    expect(validateBridgeBaseUrl("http://127.0.0.1:8080").ok).toBe(true);
    expect(validateBridgeBaseUrl("http://[::1]:8080/v1").ok).toBe(true);
  });

  it("rejects cleartext to a remote host so the key is not leaked", () => {
    const r = validateBridgeBaseUrl("http://api.example.com/v1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/https/);
  });

  it("rejects a junk scheme, a missing host, the metadata address and empty input", () => {
    expect(validateBridgeBaseUrl("ftp://api.example.com").ok).toBe(false);
    expect(validateBridgeBaseUrl("javascript:alert(1)").ok).toBe(false);
    expect(validateBridgeBaseUrl("api.example.com/v1").ok).toBe(false);
    expect(validateBridgeBaseUrl("https://").ok).toBe(false);
    expect(validateBridgeBaseUrl("https://169.254.169.254/latest/meta-data").ok).toBe(false);
    expect(validateBridgeBaseUrl("").ok).toBe(false);
    expect(validateBridgeBaseUrl("   ").ok).toBe(false);
  });
});

// F18 MED: before this fix only the root route exported an ErrorBoundary, so a render crash in
// any leaf route bubbled to the root and blanked the whole app. The leaf routes now export
// their own ErrorBoundary. expo-router wraps each such route in a per-route Try boundary (a
// class with getDerivedStateFromError that renders the exported component as the fallback, see
// expo-router/build/useScreens.js). RouteTry below mirrors that exact contract, so this proves
// the room fallback contains a crash while a sibling outside the boundary stays mounted, the
// per-view isolation SECURITY.md claims.
class RouteTry extends Component<
  { catch: (p: { error: Error; retry: () => Promise<void> }) => ReactNode; children: ReactNode },
  { error: Error | undefined }
> {
  state: { error: Error | undefined } = { error: undefined };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  retry = () => Promise.resolve(this.setState({ error: undefined }));
  render() {
    const Fallback = this.props.catch;
    return this.state.error ? <Fallback error={this.state.error} retry={this.retry} /> : this.props.children;
  }
}

describe("per-route error boundary contains a render crash", () => {
  function Boom(): never {
    throw new Error("render boom");
  }

  it("renders the room fallback and keeps a sibling mounted", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    let tree: TestRenderer.ReactTestRenderer;
    await TestRenderer.act(async () => {
      tree = TestRenderer.create(
        <View>
          <RouteTry catch={RoomErrorBoundary}>
            <Boom />
          </RouteTry>
          <Text testID="sibling">sibling stays</Text>
        </View>,
      );
      await tick();
    });
    const root = tree!.root;
    // The crashing subtree is replaced by the route's own fallback, with a retry.
    expect(root.findAllByType(Button).some((b) => b.props.title === "Try again")).toBe(true);
    // The sibling outside the boundary is untouched, so one view did not take down the app.
    expect(root.findAllByProps({ testID: "sibling" }).length).toBeGreaterThan(0);
    TestRenderer.act(() => tree!.unmount());
    spy.mockRestore();
  });
});
