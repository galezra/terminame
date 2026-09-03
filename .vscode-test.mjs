import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  files: "out/test/ext/**/*.test.js",
  workspaceFolder: "test/fixtures/workspace",
  mocha: { ui: "bdd", timeout: 60000 },
});
