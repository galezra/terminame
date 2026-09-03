export type ProviderId = "vscodeLm" | "claudeCli" | "anthropic";

export interface NameRequest {
  command: string;
  cwdBasename?: string;
}

export interface NameProvider {
  readonly id: ProviderId;
  isAvailable(): Promise<boolean>;
  /** Return the raw model answer, or null if the provider could not answer. Must reject/return promptly when `signal` aborts. */
  name(req: NameRequest, signal: AbortSignal): Promise<string | null>;
}

export const SYSTEM_PROMPT =
  "You name terminal tabs. Given a shell command and the folder it runs in, reply with only a short title of 1 to 3 words that a developer would recognise at a glance. " +
  "Examples: `npm run dev` → Start App. `git rebase -i main` → Rebase. `docker compose up` → Docker Up. `pytest tests/api` → API Tests. " +
  "No punctuation, no explanation.";

export function userPrompt(req: NameRequest): string {
  const folder = req.cwdBasename ? `\nFolder: ${req.cwdBasename}` : "";
  return `Command: ${req.command}${folder}`;
}
