import Anthropic from "@anthropic-ai/sdk";
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { NameProvider, NameRequest, SYSTEM_PROMPT, userPrompt } from "./types";

export interface AnthropicLike {
  models: { retrieve(id: string, opts?: { signal?: AbortSignal }): Promise<unknown> };
  messages: { create(params: MessageCreateParamsNonStreaming, opts?: { signal?: AbortSignal }): Promise<Message> };
}

export interface AnthropicSdkDeps {
  /** Optional key from SecretStorage. When undefined the SDK resolves env vars or an `ant auth login` profile itself. */
  getApiKey: () => Promise<string | undefined>;
  getModel: () => string;
  createClient?: (apiKey?: string) => AnthropicLike;
}

const defaultCreateClient = (apiKey?: string): AnthropicLike =>
  (apiKey ? new Anthropic({ apiKey }) : new Anthropic()) as unknown as AnthropicLike;

export class AnthropicSdkProvider implements NameProvider {
  readonly id = "anthropic" as const;
  private client: AnthropicLike | null = null;

  constructor(private readonly deps: AnthropicSdkDeps) {}

  async isAvailable(): Promise<boolean> {
    try {
      const client = (this.deps.createClient ?? defaultCreateClient)(await this.deps.getApiKey());
      await client.models.retrieve(this.deps.getModel(), { signal: AbortSignal.timeout(5000) });
      this.client = client;
      return true;
    } catch {
      this.client = null;
      return false;
    }
  }

  async name(req: NameRequest, signal: AbortSignal): Promise<string | null> {
    if (!this.client) return null;
    const res = await this.client.messages.create(
      {
        model: this.deps.getModel(),
        max_tokens: 32,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt(req) }],
      },
      { signal },
    );
    if (res.stop_reason === "refusal") return null;
    const text = res.content.find((b) => b.type === "text");
    return text && text.type === "text" ? text.text : null;
  }
}
