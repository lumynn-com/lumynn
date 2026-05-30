export interface ParsedSseEvent {
  event: string;
  data: string;
}

export interface SseParseResult {
  buffer: string;
  events: ParsedSseEvent[];
}

export function parseSseChunk(buffer: string, chunk: string): SseParseResult {
  const input = `${buffer}${chunk}`.replace(/\r\n/g, "\n");
  const parts = input.split("\n\n");
  const nextBuffer = parts.pop() ?? "";
  const events = parts.map(parseSseBlock).filter((event): event is ParsedSseEvent => Boolean(event));
  return { buffer: nextBuffer, events };
}

function parseSseBlock(block: string): ParsedSseEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const rawValue = separator === -1 ? "" : line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "event") {
      event = value || "message";
    } else if (field === "data") {
      data.push(value);
    }
  }
  if (data.length === 0) {
    return null;
  }
  return { event, data: data.join("\n") };
}
