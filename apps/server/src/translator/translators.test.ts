import { describe, it, expect } from "bun:test";
import { openaiToClaudeRequest } from "./openai-to-claude.js";
import { claudeToOpenAIChunk, claudeToOpenAINonStreaming, createTranslationState } from "./claude-to-openai.js";
import { anthropicToOpenAIRequest } from "./anthropic-to-openai.js";
import { openaiToAnthropicResponse } from "./openai-to-anthropic.js";

// ── openaiToClaudeRequest ──────────────────────────────────────────────────

describe("openaiToClaudeRequest", () => {
  it("converts a basic user message", () => {
    const result = openaiToClaudeRequest("claude-3", {
      messages: [{ role: "user", content: "hello" }],
    }, false);

    expect(result.model).toBe("claude-3");
    expect(result.stream).toBe(false);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("extracts system message into system prompt, not into messages array", () => {
    const result = openaiToClaudeRequest("claude-3", {
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hi" },
      ],
    }, false);

    expect(result.system?.[0].text).toContain("You are helpful.");
    expect(result.messages.every((m) => m.role !== "system")).toBe(true);
  });

  it("converts assistant tool_calls to tool_use blocks", () => {
    const result = openaiToClaudeRequest("claude-3", {
      messages: [
        { role: "user", content: "run ls" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1", type: "function",
            function: { name: "bash", arguments: '{"cmd":"ls"}' },
          }],
        },
        { role: "tool", tool_call_id: "call_1", content: "file.txt" },
      ],
    }, false);

    const assistantMsg = result.messages.find((m) => m.role === "assistant");
    expect(assistantMsg?.content).toContainEqual(
      expect.objectContaining({ type: "tool_use", name: "bash", id: "call_1" }),
    );
    const userMsg = result.messages.find((m) =>
      (m.content as Array<{ type: string }>).some((b) => b.type === "tool_result"),
    );
    expect(userMsg?.role).toBe("user");
  });

  it("converts tools array to Claude input_schema format", () => {
    const result = openaiToClaudeRequest("claude-3", {
      messages: [{ role: "user", content: "hi" }],
      tools: [{
        type: "function",
        function: {
          name: "bash",
          description: "run shell commands",
          parameters: { type: "object", properties: { cmd: { type: "string" } } },
        },
      }],
    }, false);

    expect(result.tools?.[0]).toMatchObject({ name: "bash", description: "run shell commands" });
    expect(result.tools?.[0].input_schema).toBeDefined();
  });
});

// ── claudeToOpenAIChunk (streaming) ────────────────────────────────────────

describe("claudeToOpenAIChunk", () => {
  it("emits assistant role chunk on message_start", () => {
    const state = createTranslationState("claude-3");
    const chunks = claudeToOpenAIChunk(
      { type: "message_start", message: { id: "msg_1", model: "claude-3" } },
      state,
    );
    expect(chunks).not.toBeNull();
    expect((chunks![0].choices as Array<{ delta: unknown }>)[0].delta).toMatchObject({ role: "assistant" });
  });

  it("emits content on text_delta", () => {
    const state = createTranslationState("claude-3");
    const chunks = claudeToOpenAIChunk(
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
      state,
    );
    expect((chunks![0].choices as Array<{ delta: unknown }>)[0].delta).toMatchObject({ content: "hello" });
  });

  it("emits tool_calls with correct name and id on tool_use block start", () => {
    const state = createTranslationState("claude-3");
    const chunks = claudeToOpenAIChunk(
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "bash" } },
      state,
    );
    const delta = (chunks![0].choices as Array<{ delta: Record<string, unknown> }>)[0].delta;
    const toolCalls = delta.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>;
    expect(toolCalls[0].function.name).toBe("bash");
    expect(toolCalls[0].id).toBe("toolu_1");
    expect(toolCalls[0].function.arguments).toBe("");
  });

  it("emits argument delta on input_json_delta", () => {
    const state = createTranslationState("claude-3");
    claudeToOpenAIChunk(
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "bash" } },
      state,
    );
    const chunks = claudeToOpenAIChunk(
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"cmd":"ls"}' } },
      state,
    );
    const delta = (chunks![0].choices as Array<{ delta: Record<string, unknown> }>)[0].delta;
    const toolCalls = delta.tool_calls as Array<{ function: { arguments: string } }>;
    expect(toolCalls[0].function.arguments).toBe('{"cmd":"ls"}');
  });

  it("maps Claude stop reasons to OpenAI finish_reason", () => {
    const cases: Array<[string, string]> = [
      ["end_turn", "stop"],
      ["max_tokens", "length"],
      ["tool_use", "tool_calls"],
      ["stop_sequence", "stop"],
    ];
    for (const [claudeReason, oaiReason] of cases) {
      const state = createTranslationState("claude-3");
      const chunks = claudeToOpenAIChunk(
        { type: "message_delta", delta: { stop_reason: claudeReason }, usage: { output_tokens: 5 } },
        state,
      );
      expect(chunks![0].choices[0].finish_reason).toBe(oaiReason);
    }
  });

  it("emits reasoning_content on thinking_delta", () => {
    const state = createTranslationState("claude-3");
    claudeToOpenAIChunk(
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      state,
    );
    const chunks = claudeToOpenAIChunk(
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "let me think..." } },
      state,
    );
    const delta = (chunks![0].choices as Array<{ delta: Record<string, unknown> }>)[0].delta;
    expect(delta.reasoning_content).toBe("let me think...");
  });
});

// ── claudeToOpenAINonStreaming ──────────────────────────────────────────────

describe("claudeToOpenAINonStreaming", () => {
  it("converts text response with usage", () => {
    const result = claudeToOpenAINonStreaming({
      id: "msg_1", model: "claude-3",
      content: [{ type: "text", text: "hello world" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    expect(result.object).toBe("chat.completion");
    const choice = (result.choices as Array<{ message: Record<string, unknown>; finish_reason: string }>)[0];
    expect(choice.message.content).toBe("hello world");
    expect(choice.finish_reason).toBe("stop");
    expect((result.usage as Record<string, number>).total_tokens).toBe(15);
  });

  it("converts tool_use blocks to tool_calls with JSON-serialized arguments", () => {
    const result = claudeToOpenAINonStreaming({
      id: "msg_1", model: "claude-3",
      content: [{ type: "tool_use", id: "toolu_1", name: "bash", input: { cmd: "ls" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 5, output_tokens: 5 },
    });

    const choice = (result.choices as Array<{ message: Record<string, unknown>; finish_reason: string }>)[0];
    expect(choice.finish_reason).toBe("tool_calls");
    const toolCalls = choice.message.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>;
    expect(toolCalls[0].id).toBe("toolu_1");
    expect(toolCalls[0].function.name).toBe("bash");
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ cmd: "ls" });
  });
});

// ── anthropicToOpenAIRequest ────────────────────────────────────────────────

describe("anthropicToOpenAIRequest", () => {
  it("converts a basic user message", () => {
    const result = anthropicToOpenAIRequest({
      model: "claude-3",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 1024,
    }, "gpt-4");

    expect(result.model).toBe("gpt-4");
    expect(result.messages.some((m) => m.role === "user")).toBe(true);
    expect(result.messages.every((m) => m.role !== "system")).toBe(true);
  });

  it("converts system string into a system message", () => {
    const result = anthropicToOpenAIRequest({
      model: "claude-3",
      system: "You are helpful.",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1024,
    }, "gpt-4");

    expect(result.messages[0]).toMatchObject({ role: "system", content: "You are helpful." });
  });

  it("converts Anthropic tools to OpenAI function format", () => {
    const result = anthropicToOpenAIRequest({
      model: "claude-3",
      messages: [{ role: "user", content: "hi" }],
      tools: [{
        name: "bash",
        description: "run shell commands",
        input_schema: { type: "object", properties: { cmd: { type: "string" } } },
      }],
      max_tokens: 1024,
    }, "gpt-4");

    expect(result.tools?.[0]).toMatchObject({
      type: "function",
      function: { name: "bash", description: "run shell commands" },
    });
  });

  it("maps tool_choice 'any' to 'required'", () => {
    const result = anthropicToOpenAIRequest({
      model: "claude-3",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "any" },
      max_tokens: 1024,
    }, "gpt-4");

    expect(result.tool_choice).toBe("required");
  });
});

// ── openaiToAnthropicResponse ───────────────────────────────────────────────

describe("openaiToAnthropicResponse", () => {
  it("converts text response with usage", () => {
    const result = openaiToAnthropicResponse({
      id: "chatcmpl_1", model: "gpt-4",
      choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }, "claude-3");

    expect(result.type).toBe("message");
    expect(result.role).toBe("assistant");
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]).toMatchObject({ type: "text", text: "hello" });
    expect(result.stop_reason).toBe("end_turn");
    expect((result.usage as Record<string, number>).input_tokens).toBe(10);
    expect((result.usage as Record<string, number>).output_tokens).toBe(5);
  });

  it("converts tool_calls to tool_use blocks with parsed input", () => {
    const result = openaiToAnthropicResponse({
      id: "chatcmpl_1", model: "gpt-4",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1", type: "function",
            function: { name: "bash", arguments: '{"cmd":"ls"}' },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }, "claude-3");

    const content = result.content as Array<{ type: string; name?: string; id?: string; input?: unknown }>;
    expect(content[0]).toMatchObject({ type: "tool_use", name: "bash", id: "call_1" });
    expect(content[0].input).toEqual({ cmd: "ls" });
    expect(result.stop_reason).toBe("tool_use");
  });

  it("maps all finish reasons to Anthropic stop_reason", () => {
    const cases: Array<[string, string]> = [
      ["stop", "end_turn"],
      ["length", "max_tokens"],
      ["tool_calls", "tool_use"],
    ];
    for (const [oai, anthropic] of cases) {
      const result = openaiToAnthropicResponse({
        id: "id", model: "gpt-4",
        choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: oai }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }, "claude-3");
      expect(result.stop_reason).toBe(anthropic);
    }
  });
});
