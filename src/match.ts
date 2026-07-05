/**
 * Quick-open style matcher for workspace symbol search: every query character
 * must appear in the target IN ORDER (case-insensitive, spaces ignored).
 * Plain substring made "#" feel broken — "payinstr" or "pr.instr" found
 * nothing even though that's exactly how quick-open users type.
 */
export function fuzzyIncludes(query: string, target: string): boolean {
  const q = query.replace(/\s+/g, "").toLowerCase();
  const t = target.toLowerCase();
  let ti = 0;
  for (const ch of q) {
    ti = t.indexOf(ch, ti);
    if (ti < 0) return false;
    ti++;
  }
  return true;
}
