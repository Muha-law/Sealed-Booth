/**
 * This node caps `eth_getLogs` at a 10,000-block range. Anything that must see
 * an election's whole event history (a trustee's tally) scans from the
 * creation block in chunks below that cap.
 */

/** Blocks per getLogs call. Under the node's 10,000 cap, with room to spare. */
export const LOG_CHUNK = 9_000n;

/**
 * Inclusive, non-overlapping [from, to] ranges covering `from..to`, each at
 * most `size` blocks. No block is scanned twice, so no event is seen twice.
 */
export function chunkRanges(from: bigint, to: bigint, size: bigint = LOG_CHUNK): [bigint, bigint][] {
  if (size <= 0n) throw new Error('chunk size must be positive');
  const out: [bigint, bigint][] = [];
  for (let start = from; start <= to; start += size) {
    const end = start + size - 1n;
    out.push([start, end < to ? end : to]);
  }
  return out;
}
