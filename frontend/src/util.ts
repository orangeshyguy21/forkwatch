// Small display helpers. All are null-safe so cards never crash on bad data.

export function shortHash(hash?: string | null): string {
  if (!hash) return '—';
  if (hash.length <= 14) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

export function relativeTime(unixSeconds?: number | null): string {
  if (!unixSeconds || unixSeconds <= 0) return '—';
  const now = Date.now() / 1000;
  const diff = Math.max(0, now - unixSeconds);
  if (diff < 45) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

export function formatBytes(bytes?: number | null): string {
  if (bytes == null || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatInt(n?: number | null): string {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US');
}

export function clsx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// Block-height format for the rails: no "#", no commas — digits grouped by 3 with a space.
// 908160 -> "908 160", 896205 -> "896 205".
export function fmtHeight(h: number): string {
  return Math.round(h)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Round x up to a 1/2/5×10ⁿ step — tick spacing that lands on round numbers. */
export function niceStep(x: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(1, x))));
  const f = x / p;
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return n * p;
}

/** Best-effort tidy-up of a coinbase tag for display. A stored tag can carry trailing extranonce /
 *  merkle bytes that happen to be printable, which surface as a spray of short random tokens
 *  (`… wmklasson4/ m[u oX ;% h j K Y`). Keep the meaningful prefix — everything up to the last token
 *  that either contains a "/" or holds a run of ≥4 alphanumerics — and drop the junk tail. Already
 *  clean tags pass through unchanged. */
export function cleanCoinbaseTag(tag?: string | null): string {
  if (!tag) return '';
  const tokens = tag.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  const meaningful = (t: string) => t.includes('/') || /[A-Za-z0-9]{4,}/.test(t);
  let last = -1;
  for (let i = 0; i < tokens.length; i++) if (meaningful(tokens[i])) last = i;
  if (last < 0) return tokens.join(' '); // nothing obviously tag-like — leave it be
  return tokens.slice(0, last + 1).join(' ');
}
