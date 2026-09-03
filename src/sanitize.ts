const MAX_WORDS = 3;
const MAX_CHARS = 24;

export function sanitizeName(raw: string): string | null {
  let s = (raw.split("\n")[0] ?? "").trim();
  s = s.replace(/^["'`*#\-\s]+/, "").replace(/["'`*.!?:;,\s]+$/, "");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return null;
  const words = s.split(" ").slice(0, MAX_WORDS).map((w) => (w === w.toLowerCase() ? w[0].toUpperCase() + w.slice(1) : w));
  s = words.join(" ");
  if (s.length > MAX_CHARS) s = s.slice(0, MAX_CHARS).trimEnd();
  return s || null;
}
