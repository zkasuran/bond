// The agent loop. A real tool-calling loop over the Vercel AI SDK streamText,
// with a step-count stop condition so a runaway model cannot loop forever. The
// provider is chosen at request time from config or a per-request override, with
// the key coming from the environment. Every model event is normalised to the
// AdapterEvent kinds the app already parses.
import { streamText, stepCountIs, type ModelMessage, type ToolSet, type LanguageModel, type TextStreamPart } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { config } from "../config.js";
import { type AdapterEvent, errText } from "./events.js";
import { buildTools } from "./tools.js";

const ANTHROPIC_DEFAULT_MODEL = "claude-3-5-sonnet-latest";

// Resolve a LanguageModel from a provider name and an optional model id. Throws
// a clear error when the selected provider has no key configured.
export function resolveModel(provider?: string, model?: string): LanguageModel {
  const name = (provider ?? config.aiProvider).toLowerCase();
  if (name === "anthropic") {
    if (!config.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    const anthropic = createAnthropic({ apiKey: config.anthropicApiKey });
    return anthropic(model || config.agentModel || ANTHROPIC_DEFAULT_MODEL);
  }
  // Default: an OpenAI-compatible endpoint. Reuse the gateway config so the
  // built-in agent works with no extra setup. .chat pins the chat-completions
  // surface, which the gateway speaks.
  if (!config.openaiApiKey) throw new Error("OPENAI_API_KEY is not set");
  const openai = createOpenAI({ apiKey: config.openaiApiKey, baseURL: config.openaiBaseUrl });
  return openai.chat(model || config.agentModel || config.openaiModel);
}

// Map one streamText event to at most one AdapterEvent. Lifecycle parts the app
// does not need (step boundaries, reasoning, raw) map to null and are dropped.
export function partToEvent(part: TextStreamPart<ToolSet>): AdapterEvent | null {
  switch (part.type) {
    case "text-delta":
      return part.text ? { kind: "text", delta: part.text } : null;
    case "tool-call":
      return { kind: "tool_call", id: part.toolCallId, name: part.toolName, args: part.input };
    case "tool-result":
      return { kind: "tool_result", id: part.toolCallId, result: part.output };
    case "tool-error":
      return { kind: "tool_result", id: part.toolCallId, result: errText(part.error), isError: true };
    case "error":
      return { kind: "error", message: errText(part.error), retryable: false };
    case "abort":
      return { kind: "error", message: "turn aborted", retryable: false };
    default:
      return null;
  }
}

export interface StreamAgentOptions {
  model: LanguageModel;
  tools: ToolSet;
  messages: ModelMessage[];
  system?: string;
  maxSteps?: number;
  signal?: AbortSignal;
  runId?: string;
}

// Stream one turn from a resolved model and tool set. Always opens with
// turn_start and closes with turn_end then a single done, so the app sees a
// clean lifecycle even on error. Never throws: an error becomes an error event.
export async function* streamAgent(opts: StreamAgentOptions): AsyncGenerator<AdapterEvent> {
  yield { kind: "turn_start", runId: opts.runId };
  try {
    const result = streamText({
      model: opts.model,
      system: opts.system,
      messages: opts.messages,
      tools: opts.tools,
      stopWhen: stepCountIs(opts.maxSteps ?? config.agentMaxSteps),
      abortSignal: opts.signal,
    });
    for await (const part of result.fullStream) {
      const event = partToEvent(part);
      if (event) yield event;
    }
  } catch (err) {
    yield { kind: "error", message: errText(err), retryable: true };
  }
  yield { kind: "turn_end", runId: opts.runId };
  yield { kind: "done" };
}

export interface RunAgentTurnInput {
  messages: ModelMessage[];
  system?: string;
  provider?: string;
  model?: string;
  maxSteps?: number;
  signal?: AbortSignal;
  runId?: string;
}

// Build the tools, resolve the model, run one turn, tear the tools down. This is
// what the route calls. Model or tool build failures surface as a clean
// turn_start, error, turn_end, done sequence.
export async function* runAgentTurn(input: RunAgentTurnInput): AsyncGenerator<AdapterEvent> {
  let model: LanguageModel;
  try {
    model = resolveModel(input.provider, input.model);
  } catch (err) {
    yield { kind: "turn_start", runId: input.runId };
    yield { kind: "error", message: errText(err), retryable: false };
    yield { kind: "turn_end", runId: input.runId };
    yield { kind: "done" };
    return;
  }

  const built = await buildTools();
  try {
    yield* streamAgent({
      model,
      tools: built.tools,
      messages: input.messages,
      system: input.system,
      maxSteps: input.maxSteps,
      signal: input.signal,
      runId: input.runId,
    });
  } finally {
    await built.cleanup();
  }
}
