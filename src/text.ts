const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function excerpt(text: string, max = 220): string {
  const clean = collapse(text);
  if (!clean) return "";
  const first = clean.split(/(?<=[.!?])\s/)[0] ?? clean;
  if (first.length <= max) return first;
  const cut = clean.slice(0, max - 1);
  const trimmed = cut.replace(/\s+\S*$/, "");
  return `${trimmed || cut}…`;
}

export function quote(text: string): string {
  return `“${collapse(text)}”`;
}

export function inlineCode(text: string): string {
  const clean = text.replace(/`/g, "'").trim();
  return `\`${clean}\``;
}
