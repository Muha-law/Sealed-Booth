import { describe, expect, it } from 'vitest';
import { chunkRanges, LOG_CHUNK } from '../src/core/logRange.js';

describe('chunkRanges', () => {
  it('covers every block exactly once, each chunk within the cap', () => {
    const from = 10_808_777n;
    const to = 10_834_000n;
    const ranges = chunkRanges(from, to);
    expect(ranges[0]![0]).toBe(from);
    expect(ranges.at(-1)![1]).toBe(to);
    for (let i = 0; i < ranges.length; i++) {
      const [a, b] = ranges[i]!;
      expect(b - a + 1n <= LOG_CHUNK).toBe(true);
      expect(b - a + 1n < 10_000n).toBe(true);
      if (i > 0) expect(a).toBe(ranges[i - 1]![1] + 1n);
    }
    const covered = ranges.reduce((n, [a, b]) => n + (b - a + 1n), 0n);
    expect(covered).toBe(to - from + 1n);
  });

  it('handles a single block and an exact multiple', () => {
    expect(chunkRanges(5n, 5n)).toEqual([[5n, 5n]]);
    expect(chunkRanges(0n, 17_999n)).toEqual([
      [0n, 8_999n],
      [9_000n, 17_999n],
    ]);
  });

  it('returns nothing for an empty range', () => {
    expect(chunkRanges(10n, 9n)).toEqual([]);
  });
});
