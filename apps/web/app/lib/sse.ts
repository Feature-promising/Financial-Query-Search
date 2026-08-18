import type { ResearchEvent } from "./research-types";
import { parseResearchEvent } from "./run-event";
import { SseFrameBuffer, type SseFrame } from "./sse-frame-parser";

export async function consumeSse(stream: ReadableStream<Uint8Array>, onEvent: (event: ResearchEvent) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const frames = new SseFrameBuffer();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      for (const frame of frames.push(decoder.decode())) dispatch(frame, onEvent);
      for (const frame of frames.finish()) dispatch(frame, onEvent);
      return;
    }
    for (const frame of frames.push(decoder.decode(chunk.value, { stream: true }))) dispatch(frame, onEvent);
  }
}

function dispatch(frame: SseFrame, onEvent: (event: ResearchEvent) => void): void {
  const data = frame.data;
  if (!data) return;
  let raw: unknown;
  try { raw = JSON.parse(data); } catch { return; }
  const event = parseResearchEvent(raw);
  if (!event) return;
  const sequence = Number(frame.id);
  onEvent(Number.isSafeInteger(sequence) && sequence > 0 ? { ...event, sequence } : event);
}
