export interface FilingTextChunk {
  /** Zero-based start and exclusive end offsets in the normalized filing text. */
  startOffset: number;
  endOffset: number;
  content: string;
}

const DEFAULT_MAX_CHARS = 4_000;
const DEFAULT_MAX_CHUNKS = 8;

/**
 * Produces deterministic, bounded citation fragments from normalized filing
 * text. Offsets always refer to the exact normalized text whose SHA-256 is
 * retained in each fragment's metadata.
 */
export function chunkFilingText(text: string, options: { maxChars?: number; maxChunks?: number } = {}): FilingTextChunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS;
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error("filing chunk size must be a positive integer");
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 1) throw new Error("filing chunk count must be a positive integer");

  const chunks: FilingTextChunk[] = [];
  let cursor = 0;
  while (cursor < text.length && chunks.length < maxChunks) {
    const ceiling = Math.min(text.length, cursor + maxChars);
    const end = chooseBoundary(text, cursor, ceiling);
    const raw = text.slice(cursor, end);
    const leadingWhitespace = raw.length - raw.trimStart().length;
    const content = raw.trim();
    if (content) {
      const startOffset = cursor + leadingWhitespace;
      chunks.push({ startOffset, endOffset: startOffset + content.length, content });
    }
    cursor = end;
  }
  return chunks;
}

function chooseBoundary(text: string, start: number, ceiling: number): number {
  if (ceiling === text.length) return ceiling;
  const lastWhitespace = text.lastIndexOf(" ", ceiling);
  return lastWhitespace > start + Math.floor((ceiling - start) / 2) ? lastWhitespace : ceiling;
}
