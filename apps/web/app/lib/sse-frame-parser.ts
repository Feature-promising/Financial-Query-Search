/**
 * Minimal standards-compliant SSE framing. Network transports may split any
 * byte sequence, normalize line endings, or send comment heartbeats; this
 * parser keeps those mechanics outside application event validation.
 */
export interface SseFrame {
  id?: string;
  event?: string;
  data?: string;
}

export class SseFrameBuffer {
  private buffer = "";

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    return this.takeCompleteFrames();
  }

  finish(): SseFrame[] {
    const trailing = this.buffer;
    this.buffer = "";
    return trailing ? [parseSseFrame(trailing)] : [];
  }

  private takeCompleteFrames(): SseFrame[] {
    const frames: SseFrame[] = [];
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(this.buffer);
      if (!boundary || boundary.index === undefined) return frames;
      frames.push(parseSseFrame(this.buffer.slice(0, boundary.index)));
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
    }
  }
}

export function parseSseFrame(frame: string): SseFrame {
  const data: string[] = [];
  let id: string | undefined;
  let event: string | undefined;
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const rawValue = separator < 0 ? "" : line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "data") data.push(value);
    else if (field === "id" && !value.includes("\0")) id = value;
    else if (field === "event") event = value;
  }
  return { ...(id === undefined ? {} : { id }), ...(event === undefined ? {} : { event }), ...(data.length ? { data: data.join("\n") } : {}) };
}
