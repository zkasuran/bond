// The wallet Send flow must route through the spend gate before it builds or signs anything.
// WalletScreen is rendered with its solana and protection deps mocked, then the Send button
// is pressed: a denied gate must stop the transfer, an allowed gate must let it build.
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("expo-haptics", () => ({ selectionAsync: jest.fn() }));
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
  return { useWallet: (sel: (s: typeof state) => unknown) => sel(state) };
});

jest.mock("@/state/store", () => ({
  useBond: (sel: (s: { identity: unknown }) => unknown) =>
    sel({ identity: { did: "did:key:zMe", displayName: "Me", kind: "human" } }),
}));

jest.mock("@/protection/gate", () => ({ requireAuth: jest.fn() }));

import TestRenderer from "react-test-renderer";
import { TextInput } from "react-native";
import WalletScreen from "../index";
import { Button } from "@/components/ui/Button";
import { requireAuth } from "@/protection/gate";
import { buildUsdcTransfer } from "@/solana/usdc";
import { signAndSendTransaction } from "@/solana/wallet";

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
