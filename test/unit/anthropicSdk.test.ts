import { describe, it, expect } from "vitest";
import { AnthropicSdkProvider, AnthropicLike } from "../../src/providers/anthropicSdk";

function fakeClient(opts: { retrieveOk?: boolean; text?: string } = {}): AnthropicLike & { lastParams?: unknown } {
  const c: AnthropicLike & { lastParams?: unknown } = {
    models: { retrieve: async () => { if (opts.retrieveOk === false) throw new Error("401"); return {}; } },
    messages: {
      create: async (params) => {
        c.lastParams = params;
        return { content: [{ type: "text", text: opts.text ?? "Start App" }], stop_reason: "end_turn" } as never;
      },
    },
  };
  return c;
}

describe("AnthropicSdkProvider", () => {
  it("is unavailable when the client cannot be constructed", async () => {
    const p = new AnthropicSdkProvider({ getApiKey: async () => undefined, getModel: () => "claude-haiku-4-5", createClient: () => { throw new Error("no key"); } });
    expect(await p.isAvailable()).toBe(false);
  });
  it("is unavailable when the probe request fails", async () => {
    const p = new AnthropicSdkProvider({ getApiKey: async () => "k", getModel: () => "claude-haiku-4-5", createClient: () => fakeClient({ retrieveOk: false }) });
    expect(await p.isAvailable()).toBe(false);
  });
  it("sends system + user prompt to the configured model and returns text", async () => {
    const client = fakeClient({ text: "Dev Server" });
    const p = new AnthropicSdkProvider({ getApiKey: async () => "k", getModel: () => "claude-haiku-4-5", createClient: () => client });
    expect(await p.isAvailable()).toBe(true);
    const out = await p.name({ command: "npm run dev", cwdBasename: "web" }, new AbortController().signal);
    expect(out).toBe("Dev Server");
    const params = client.lastParams as { model: string; system: string; messages: Array<{ content: string }> };
    expect(params.model).toBe("claude-haiku-4-5");
    expect(params.system).toContain("You name terminal tabs");
    expect(params.messages[0].content).toContain("Folder: web");
  });
  it("treats a refusal stop reason as a miss", async () => {
    const client = fakeClient({ text: "Should Not Be Used" });
    client.messages.create = async () => ({ content: [{ type: "text", text: "Should Not Be Used" }], stop_reason: "refusal" } as never);
    const p = new AnthropicSdkProvider({ getApiKey: async () => "k", getModel: () => "claude-haiku-4-5", createClient: () => client });
    expect(await p.isAvailable()).toBe(true);
    expect(await p.name({ command: "rm -rf /" }, new AbortController().signal)).toBeNull();
  });
});
