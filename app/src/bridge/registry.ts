// The adapter registry. The connect UI lists these and mints one on demand. A new
// runtime that speaks OpenAI-HTTP or MCP is supported by the generic adapter with no
// Bond release; Hermes and OpenClaw are two concrete adapters over the same interface.
import type { AdapterKind, GatewayAdapter, GatewayConfig } from "./adapter";
import { BondOwnGatewayAdapter } from "./adapters/own";
import { GenericOpenAIAdapter } from "./adapters/generic";
import { HermesAdapter } from "./adapters/hermes";
import { OpenClawAdapter } from "./adapters/openclaw";

export interface AdapterInfo {
  kind: AdapterKind;
  displayName: string;
  blurb: string;
  make: () => GatewayAdapter;
  defaults?: Partial<GatewayConfig>;
  /** true when it needs a base URL and key from the user (not the built-in Bond agent). */
  requiresConfig: boolean;
}

export const ADAPTERS: Record<AdapterKind, AdapterInfo> = {
  bond: {
    kind: "bond",
    displayName: "Bond gateway",
    blurb: "The built-in agent. Zero setup, works the moment you open a room.",
    make: () => new BondOwnGatewayAdapter(),
    requiresConfig: false,
  },
  generic: {
    kind: "generic",
    displayName: "OpenAI-compatible",
    blurb: "Any gateway exposing an OpenAI-style API. Bring your own base URL and key.",
    make: () => new GenericOpenAIAdapter(),
    requiresConfig: true,
  },
  hermes: {
    kind: "hermes",
    displayName: "Hermes",
    blurb: "The Nous Research agent runtime, over its run API.",
    make: () => new HermesAdapter(),
    defaults: { baseUrl: "http://localhost:8642/v1" },
    requiresConfig: true,
  },
  openclaw: {
    kind: "openclaw",
    displayName: "OpenClaw",
    blurb: "The self-hosted gateway to your chats, over its OpenAI-HTTP surface.",
    make: () => new OpenClawAdapter(),
    defaults: { baseUrl: "http://localhost:18789/v1" },
    requiresConfig: true,
  },
};

export function makeAdapter(kind: AdapterKind): GatewayAdapter {
  return ADAPTERS[kind].make();
}

export const ADAPTER_LIST: AdapterInfo[] = Object.values(ADAPTERS);
