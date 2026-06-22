import { describe, it, expect } from "bun:test";
import { createOaiSseExtractor, createAnthropicSseExtractor } from "./sse-extractors.js";

function oaiLine(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n`;
}

function anthropicEventLine(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ── createOaiSseExtractor ──────────────────────────────────────────────────

describe("createOaiSseExtractor", () => {
  it("extracts text content across chunks", () => {
    const ext = createOaiSseExtractor();
    ext.feed(oaiLine({ choices: [{ delta: { content: "hello" } }] }));
    ext.feed(oaiLine({ choices: [{ delta: { content: " world" } }] }));
    ext.feed("data: [DONE]\n");
    expect(ext.finish().content).toBe("hello world");
  });

  it("does NOT duplicate tool name when name arrives in first chunk (regression)", () => {
    const ext = createOaiSseExtractor();
    // First delta carries the complete name
    ext.feed(oaiLine({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "" } }] } }] }));
    // Subsequent deltas carry only arguments
    ext.feed(oaiLine({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd":"ls"}' } }] } }] }));
    ext.feed("data: [DONE]\n");
    const { toolCalls } = ext.finish();
    expect(toolCalls[0].name).toBe("bash");
  });

  it("accumulates tool arguments across multiple chunks", () => {
    const ext = createOaiSseExtractor();
    ext.feed(oaiLine({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "fn", arguments: '{"a"' } }] } }] }));
    ext.feed(oaiLine({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"b"}' } }] } }] }));
    const { toolCalls } = ext.finish();
    expect(toolCalls[0].arguments).toBe('{"a":"b"}');
  });

  it("extracts reasoning_content", () => {
    const ext = createOaiSseExtractor();
    ext.feed(oaiLine({ choices: [{ delta: { reasoning_content: "thinking..." } }] }));
    expect(ext.finish().reasoning).toBe("thinking...");
  });

  it("strips <think> blocks from content into reasoning", () => {
    const ext = createOaiSseExtractor();
    ext.feed(oaiLine({ choices: [{ delta: { content: "<think>inner reasoning</think>actual answer" } }] }));
    const { content, reasoning } = ext.finish();
    expect(content).toBe("actual answer");
    expect(reasoning).toBe("inner reasoning");
  });
});

// ── createAnthropicSseExtractor ────────────────────────────────────────────

describe("createAnthropicSseExtractor", () => {
  it("extracts text content", () => {
    const ext = createAnthropicSseExtractor();
    ext.feed(anthropicEventLine("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    ext.feed(anthropicEventLine("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } }));
    expect(ext.finish().content).toBe("hello");
  });

  it("extracts tool_use with name and accumulated input", () => {
    const ext = createAnthropicSseExtractor();
    ext.feed(anthropicEventLine("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "bash" } }));
    ext.feed(anthropicEventLine("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"cmd"' } }));
    ext.feed(anthropicEventLine("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ':"ls"}' } }));
    const { toolCalls } = ext.finish();
    expect(toolCalls[0]).toMatchObject({ name: "bash", id: "toolu_1", arguments: '{"cmd":"ls"}' });
  });
});
