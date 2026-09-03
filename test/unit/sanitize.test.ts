import { describe, it, expect } from "vitest";
import { sanitizeName } from "../../src/sanitize";

describe("sanitizeName", () => {
  it("trims quotes, punctuation and takes the first line", () => {
    expect(sanitizeName('"Start App."\nBecause it runs the dev server')).toBe("Start App");
    expect(sanitizeName("**Rebase**")).toBe("Rebase");
  });
  it("caps at 3 words and 24 chars", () => {
    expect(sanitizeName("Start The Development Server Now")).toBe("Start The Development");
    expect(sanitizeName("Supercalifragilisticexpialidocious Build")).toBe("Supercalifragilisticexpi");
  });
  it("title-cases lowercase words but keeps acronyms", () => {
    expect(sanitizeName("api tests")).toBe("Api Tests");
    expect(sanitizeName("SSH prod")).toBe("SSH Prod");
  });
  it("returns null for empty or whitespace", () => {
    expect(sanitizeName("   ")).toBeNull();
    expect(sanitizeName('""')).toBeNull();
    expect(sanitizeName("()")).toBeNull();
    expect(sanitizeName("---")).toBeNull();
  });
});
