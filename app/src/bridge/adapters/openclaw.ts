// OpenClaw adapter, path A from the research: talk to OpenClaw as an OpenAI-compatible
// client plus MCP. Base URL is http://<host>:18789/v1, bearer auth, optional
// x-openclaw-model and x-openclaw-session-key headers to pin a Bond thread to an
// OpenClaw session. The OpenAI-HTTP surface is disabled by default, so connect turns a
// 404 into an actionable setup message. See docs/DESIGN.md sec 4.
import type { GatewayCapabilities, GatewayConfig } from "../adapter";
import { GenericOpenAIAdapter } from "./generic";

export class OpenClawAdapter extends GenericOpenAIAdapter {
  readonly id = "openclaw";
  readonly displayName = "OpenClaw";

  async connect(config: GatewayConfig): Promise<GatewayCapabilities> {
    const withSession: GatewayConfig = {
      ...config,
      sessionHeader: config.sessionHeader ?? "x-openclaw-session-key",
    };
    try {
      return await super.connect(withSession);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (msg.includes("404")) {
        throw new Error(
          "OpenClaw's OpenAI-HTTP surface is disabled. Enable gateway.http.endpoints.chatCompletions on your OpenClaw host, then reconnect.",
        );
      }
      throw e;
    }
  }

  protected capabilities(): GatewayCapabilities {
    return {
      streaming: true,
      tools: "mcp",
      sessions: true,
      threading: false,
      multiAgent: true,
      identity: this.config.apiKey ? "token" : "none",
      transports: ["openai-http", "mcp"],
    };
  }
}
