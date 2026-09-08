/** Rolling trade-count window (PRD Step 6). Boundary is inclusive (VL-4). */
export function countInWindow(timestamps: string[], nowIso: string, windowSeconds: number): number {
  const now = Date.parse(nowIso);
  const cutoff = now - windowSeconds * 1000;
  let n = 0;
  for (const t of timestamps) {
    const ms = Date.parse(t);
    if (ms >= cutoff && ms <= now) n++;
  }
  return n;
}
