import { describe, it, expect } from "vitest";
import { normalizeCommand, pickSegment, isIgnored, matchRules, fallbackName, ruleName } from "../../src/rules";

describe("pickSegment", () => {
  it("uses the last segment of && / ; / || chains", () => {
    expect(pickSegment("npm install && npm run dev")).toBe("npm run dev");
    expect(pickSegment("cd api; pytest")).toBe("pytest");
    expect(pickSegment("make || echo failed")).toBe("echo failed");
  });
  it("uses the first segment of a pipeline", () => {
    expect(pickSegment("cat app.log | grep ERROR")).toBe("cat app.log");
  });
  it("chain wins over pipe", () => {
    expect(pickSegment("npm run build && tail -f out.log | grep x")).toBe("tail -f out.log");
  });
});

describe("normalizeCommand", () => {
  it("strips sudo/time/env and KEY=value prefixes", () => {
    expect(normalizeCommand("sudo npm run dev")).toBe("npm run dev");
    expect(normalizeCommand("NODE_ENV=dev PORT=3000 npm run dev")).toBe("npm run dev");
    expect(normalizeCommand("time pytest -q")).toBe("pytest -q");
  });
  it("drops trailing & and collapses whitespace", () => {
    expect(normalizeCommand("  npm   run dev &")).toBe("npm run dev");
  });
  it("applies segment selection", () => {
    expect(normalizeCommand("FOO=1 npm i && npm run dev")).toBe("npm run dev");
  });
});

describe("isIgnored", () => {
  it("ignores trivial commands and very short ones", () => {
    expect(isIgnored("ls -la")).toBe(true);
    expect(isIgnored("cd ..")).toBe(true);
    expect(isIgnored("clear")).toBe(true);
    expect(isIgnored("vi")).toBe(true);
    expect(isIgnored("")).toBe(true);
  });
  it("does not ignore real commands", () => {
    expect(isIgnored("npm run dev")).toBe(false);
  });
  it("honours extra ignore words", () => {
    expect(isIgnored("make lint", ["make"])).toBe(true);
  });
});

describe("matchRules", () => {
  it("matches built-in prefixes and wildcards", () => {
    expect(matchRules("npm run dev")).toBe("Start App");
    expect(matchRules("pnpm dev --host")).toBe("Start App");
    expect(matchRules("vitest --watch")).toBe("Tests");
    expect(matchRules("git rebase -i main")).toBe("Rebase");
    expect(matchRules("docker compose up -d")).toBe("Docker Up");
    expect(matchRules("npm install")).toBe("Install");
    expect(matchRules("npm i lodash")).toBe("Install");
    expect(matchRules("yarn")).toBe("Install");
  });
  it("does not match on partial words", () => {
    expect(matchRules("npm run development-report")).toBeNull();
    expect(matchRules("gitk")).toBeNull();
  });
  it("captures <word> placeholders", () => {
    expect(matchRules("ssh prod-1")).toBe("SSH prod-1");
  });
  it("checks user rules first", () => {
    expect(matchRules("npm run dev", [{ match: "npm run dev", name: "Dev Server" }])).toBe("Dev Server");
    expect(matchRules("make deploy", [{ match: "make deploy*", name: "Deploy" }])).toBe("Deploy");
  });
});

describe("fallbackName", () => {
  it("title-cases the first word and strips paths", () => {
    expect(fallbackName("terraform plan")).toBe("Terraform");
    expect(fallbackName("./scripts/deploy.sh staging")).toBe("Deploy.sh");
  });
});

describe("ruleName", () => {
  it("prefers a rule, else falls back", () => {
    expect(ruleName("npm test")).toBe("Tests");
    expect(ruleName("terraform plan")).toBe("Terraform");
  });
});
