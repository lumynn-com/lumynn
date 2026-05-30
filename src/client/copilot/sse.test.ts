import assert from "node:assert/strict";
import test from "node:test";
import { parseSseChunk } from "./sse";

test("parseSseChunk parses complete and partial SSE events", () => {
  let parsed = parseSseChunk("", "event: status\ndata: {\"message\":\"thin");
  assert.equal(parsed.events.length, 0);
  assert.ok(parsed.buffer.length > 0);

  parsed = parseSseChunk(parsed.buffer, "king\"}\n\nevent: message_delta\ndata: {\"text\":\"hi\"}\n\n");
  assert.equal(parsed.buffer, "");
  assert.deepEqual(parsed.events, [
    { event: "status", data: "{\"message\":\"thinking\"}" },
    { event: "message_delta", data: "{\"text\":\"hi\"}" }
  ]);
});

test("parseSseChunk joins multiline data fields", () => {
  const parsed = parseSseChunk("", "event: message\ndata: first\ndata: second\n\n");
  assert.deepEqual(parsed.events, [{ event: "message", data: "first\nsecond" }]);
});
