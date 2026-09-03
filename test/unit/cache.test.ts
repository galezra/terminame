import { describe, it, expect } from "vitest";
import { NameCache, KeyValueStore } from "../../src/cache";

function memStore(): KeyValueStore & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: <T>(k: string) => data[k] as T | undefined,
    update: async (k: string, v: unknown) => { data[k] = v; },
  };
}

describe("NameCache", () => {
  it("round-trips and persists to the store", async () => {
    const store = memStore();
    const c = new NameCache(store);
    await c.set("npm run dev", "Start App");
    expect(c.get("npm run dev")).toBe("Start App");
    expect(new NameCache(store).get("npm run dev")).toBe("Start App");
  });
  it("evicts oldest entries beyond max", async () => {
    const c = new NameCache(memStore(), { max: 2 });
    await c.set("a", "A"); await c.set("b", "B"); await c.set("c", "C");
    expect(c.get("a")).toBeUndefined();
    expect(c.get("c")).toBe("C");
    expect(c.size).toBe(2);
  });
  it("clears", async () => {
    const c = new NameCache(memStore());
    await c.set("a", "A"); await c.clear();
    expect(c.get("a")).toBeUndefined();
  });
});
