const MAX_WORDS = 3;
const MAX_NAME_CHARS = 24;

/** Trim a name to `MAX_NAME_CHARS` without leaving a trailing space. */
export function capLength(s: string): string {
  return s.length > MAX_NAME_CHARS ? s.slice(0, MAX_NAME_CHARS).trimEnd() : s;
}

export function sanitizeName(raw: string): string | null {
  let s = (raw.split("\n")[0] ?? "").trim();
  s = s.replace(/^["'`*#\-\s•(\[]+/, "").replace(/["'`*.!?:;,\s)\]]+$/, "");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (!/[\p{L}\p{N}]/u.test(s)) return null;
  const words = s.split(" ").slice(0, MAX_WORDS).map((w) => (w === w.toLowerCase() ? w[0].toUpperCase() + w.slice(1) : w));
  s = capLength(words.join(" "));
  return s || null;
}
