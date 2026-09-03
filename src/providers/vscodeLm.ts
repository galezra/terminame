import * as vscode from "vscode";
import { NameProvider, NameRequest, SYSTEM_PROMPT, userPrompt } from "./types";

export class VscodeLmProvider implements NameProvider {
  readonly id = "vscodeLm" as const;
  private model: vscode.LanguageModelChat | undefined;

  async isAvailable(): Promise<boolean> {
    try {
      const models = await vscode.lm.selectChatModels();
      this.model = models[0];
      return this.model !== undefined;
    } catch {
      return false;
    }
  }

  async name(req: NameRequest, signal: AbortSignal): Promise<string | null> {
    if (!this.model) return null;
    const cts = new vscode.CancellationTokenSource();
    const onAbort = () => cts.cancel();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await this.model.sendRequest(
        [vscode.LanguageModelChatMessage.User(`${SYSTEM_PROMPT}\n\n${userPrompt(req)}`)],
        {},
        cts.token,
      );
      let out = "";
      for await (const chunk of response.text) out += chunk;
      return out;
    } catch (e) {
      // NoPermissions (user declined the one-time consent) or NotFound — treat as a miss; Namer's three-strikes handles the rest.
      if (e instanceof vscode.LanguageModelError) return null;
      throw e;
    } finally {
      signal.removeEventListener("abort", onAbort);
      cts.dispose();
    }
  }
}
