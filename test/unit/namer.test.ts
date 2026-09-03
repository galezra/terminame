import { describe, it, expect, vi } from "vitest";
import { Namer, NamerOptions } from "../../src/namer";
import { NameCache, KeyValueStore } from "../../src/cache";
import { NameProvider, ProviderId } from "../../src/providers/types";

function store(): KeyValueStore {
  const d: Record<string, unknown> = {};
  return { get: <T>(k: string) => d[k] as T | undefined, update: async (k, v) => { d[k] = v; } };
}

function fake(id: ProviderId, opts: { available?: boolean; answer?: string | null | Error; delayMs?: number } = {}): NameProvider & { calls: number } {
  const p = {
    id,
    calls: 0,
    isAvailable: async () => opts.available ?? true,
    name: (_req: unknown, signal: AbortSignal) =>
      new Promise<string | null>((resolve, reject) => {
        p.calls++;
        const t = setTimeout(() => {
          if (opts.answer instanceof Error) reject(opts.answer);
          else resolve(opts.answer ?? "Model Name");
        }, opts.delayMs ?? 0);
        signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); });
      }),
  };
  return p;
}

const base = (over: Partial<NamerOptions> = {}): NamerOptions => ({
  timeoutMs: 50, maxFailures: 3, forced: "auto", userRules: [], log: () => {}, ...over,
});

describe("Namer.init", () => {
  it("picks the first available provider in order", async () => {
    const n = new Namer([fake("vscodeLm", { available: false }), fake("claudeCli"), fake("anthropic")], new NameCache(store()), base());
    expect(await n.init()).toBe("claudeCli");
  });
  it("returns rules when none available", async () => {
    const n = new Namer([fake("vscodeLm", { available: false })], new NameCache(store()), base());
    expect(await n.init()).toBe("rules");
  });
  it("honours a forced provider and forced rules", async () => {
    expect(await new Namer([fake("vscodeLm"), fake("anthropic")], new NameCache(store()), base({ forced: "anthropic" })).init()).toBe("anthropic");
    expect(await new Namer([fake("vscodeLm")], new NameCache(store()), base({ forced: "rules" })).init()).toBe("rules");
  });
});

describe("Namer.name", () => {
  it("uses cache first", async () => {
    const p = fake("claudeCli");
    const cache = new NameCache(store());
    await cache.set("npm run dev", "Cached");
    const n = new Namer([p], cache, base()); await n.init();
    expect(await n.name({ command: "npm run dev" }, new AbortController().signal)).toEqual({ name: "Cached", source: "cache" });
    expect(p.calls).toBe(0);
  });
  it("uses the model, sanitises, and caches", async () => {
    const p = fake("claudeCli", { answer: '"dev server."' });
    const cache = new NameCache(store());
    const n = new Namer([p], cache, base()); await n.init();
    expect(await n.name({ command: "npm run dev" }, new AbortController().signal)).toEqual({ name: "Dev Server", source: "model" });
    expect(cache.get("npm run dev")).toBe("Dev Server");
  });
  it("falls back to rules on timeout without caching", async () => {
    const p = fake("claudeCli", { delayMs: 500 });
    const cache = new NameCache(store());
    const n = new Namer([p], cache, base({ timeoutMs: 20 })); await n.init();
    expect(await n.name({ command: "npm run dev" }, new AbortController().signal)).toEqual({ name: "Start App", source: "rules" });
    expect(cache.get("npm run dev")).toBeUndefined();
  });
  it("returns null when the caller aborts", async () => {
    const p = fake("claudeCli", { delayMs: 500 });
    const n = new Namer([p], new NameCache(store()), base({ timeoutMs: 1000 })); await n.init();
    const ac = new AbortController();
    const pending = n.name({ command: "npm run dev" }, ac.signal);
    ac.abort();
    expect(await pending).toBeNull();
  });
  it("disables a provider after maxFailures and advances to the next", async () => {
    const bad = fake("vscodeLm", { answer: new Error("boom") });
    const good = fake("claudeCli", { answer: "Good" });
    const n = new Namer([bad, good], new NameCache(store()), base({ maxFailures: 2 })); await n.init();
    const sig = () => new AbortController().signal;
    expect((await n.name({ command: "terraform plan" }, sig()))!.source).toBe("rules");
    expect((await n.name({ command: "terraform apply" }, sig()))!.source).toBe("rules");
    expect(n.activeId).toBe("claudeCli");
    expect(await n.name({ command: "terraform destroy" }, sig())).toEqual({ name: "Good", source: "model" });
  });
  it("uses rules when no provider", async () => {
    const n = new Namer([], new NameCache(store()), base()); await n.init();
    expect(await n.name({ command: "terraform plan" }, new AbortController().signal)).toEqual({ name: "Terraform", source: "rules" });
  });
});
