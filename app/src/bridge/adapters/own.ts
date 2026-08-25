// Bond's own gateway adapter. Targets Bond's backend (server/), which exposes the
// OpenAI /v1/chat/completions surface over the house gateway and adds sessions, MCP
// tools and multi-agent routing. This is the default agent for a new user, so the aha
// moment works with zero setup. The gateway and the exact model are never named in
// tracked code, the store listing, the video or the app. See DESIGN.md sec 4.
import type { GatewayCapabilities } from "../adapter";
import { GenericOpenAIAdapter } from "./generic";

export class BondOwnGatewayAdapter extends GenericOpenAIAdapter {
  readonly id = "bond";
  readonly displayName = "Bond gateway";

  protected capabilities(): GatewayCapabilities {
    return {
      streaming: true,
      tools: "mcp",
      sessions: true,
      threading: true,
      multiAgent: true,
      identity: "token",
      transports: ["openai-http", "mcp"],
    };
  }
}
