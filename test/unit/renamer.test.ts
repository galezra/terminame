import { describe, it, expect } from "vitest";
import { Renamer, RenamerHost } from "../../src/renamer";

type Term = { id: string };

function host(active: { t?: Term }): RenamerHost<Term> & { names: Map<string, string>; renames: string[]; focused: string[] } {
  const names = new Map<string, string>();
  const h = {
    names, renames: [] as string[], focused: [] as string[],
    activeTerminal: () => active.t,
    currentName: (t: Term) => names.get(t.id) ?? "zsh",
    rename: async (t: Term, n: string) => { names.set(t.id, n); h.renames.push(`${t.id}=${n}`); },
    focus: (t: Term) => { h.focused.push(t.id); active.t = t; },
  };
  return h;
}

describe("Renamer", () => {
  const a: Term = { id: "a" }, b: Term = { id: "b" };

  it("renames the active terminal immediately", async () => {
    const h = host({ t: a }); const r = new Renamer(h, { aggressive: false });
    await r.setName(a, "Start App");
    expect(h.names.get("a")).toBe("Start App");
  });
  it("queues for a background terminal and applies when it becomes active", async () => {
    const h = host({ t: a }); const r = new Renamer(h, { aggressive: false });
    await r.setName(b, "Tests");
    expect(h.names.get("b")).toBeUndefined();
    await r.onActiveChanged(b);
    expect(h.names.get("b")).toBe("Tests");
  });
  it("aggressive mode focuses, renames, and restores focus", async () => {
    const act = { t: a }; const h = host(act); const r = new Renamer(h, { aggressive: true });
    await r.setName(b, "Tests");
    expect(h.names.get("b")).toBe("Tests");
    expect(h.focused).toEqual(["b", "a"]);
  });
  it("stops renaming a terminal the user renamed by hand", async () => {
    const h = host({ t: a }); const r = new Renamer(h, { aggressive: false });
    await r.setName(a, "Start App");
    h.names.set("a", "my server");           // user rename
    await r.setName(a, "Tests");
    expect(h.names.get("a")).toBe("my server");
    expect(r.isUserOwned(a)).toBe(true);
  });
  it("does not treat its own previous name or the shell default as user-owned", async () => {
    const h = host({ t: a }); const r = new Renamer(h, { aggressive: false });
    await r.setName(a, "Start App");
    await r.setName(a, "Tests");
    expect(h.names.get("a")).toBe("Tests");
    expect(r.isUserOwned(a)).toBe(false);
  });
  it("onCommandEnd honours idleName", async () => {
    const h = host({ t: a }); const r = new Renamer(h, { aggressive: false });
    await r.setName(a, "Start App");
    await r.onCommandEnd(a, "keep", "web"); expect(h.names.get("a")).toBe("Start App");
    await r.onCommandEnd(a, "folder", "web"); expect(h.names.get("a")).toBe("web");
    await r.onCommandEnd(a, "shell"); expect(h.names.get("a")).toBe("zsh");
  });
  it("forget drops pending names", async () => {
    const h = host({ t: a }); const r = new Renamer(h, { aggressive: false });
    await r.setName(b, "Tests"); r.forget(b); await r.onActiveChanged(b);
    expect(h.names.get("b")).toBeUndefined();
  });
  it("aggressive mode restores focus even when rename fails", async () => {
    const act = { t: a }; const h = host(act); const r = new Renamer(h, { aggressive: true });
    h.rename = async () => { throw new Error("rename failed"); };
    await expect(r.setName(b, "Tests")).rejects.toThrow("rename failed");
    expect(h.focused).toEqual(["b", "a"]);
    expect(act.t).toBe(a);
  });
  it("release clears user ownership but keeps the original name", async () => {
    const h = host({ t: a }); const r = new Renamer(h, { aggressive: false });
    await r.setName(a, "Start App");
    h.names.set("a", "mine");
    await r.setName(a, "Tests");            // flags user-owned
    expect(r.isUserOwned(a)).toBe(true);
    r.release(a);
    expect(r.isUserOwned(a)).toBe(false);
    await r.setName(a, "Tests");
    expect(h.names.get("a")).toBe("Tests");
    await r.onCommandEnd(a, "shell");
    expect(h.names.get("a")).toBe("zsh");   // original preserved through release
  });
});
