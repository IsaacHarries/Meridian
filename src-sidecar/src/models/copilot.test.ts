import { describe, expect, it } from "vitest";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  extractCompletionDelta,
  parseSseFrames,
  toCopilotMessages,
  toOpenAITools,
} from "./copilot.js";

describe("copilot message conversion", () => {
  it("places system messages at the top, regardless of original order", () => {
    const wire = toCopilotMessages([
      new HumanMessage("hi"),
      new SystemMessage("you are a helpful assistant"),
      new AIMessage("hello"),
    ]);
    expect(wire).toEqual([
      { role: "system", content: "you are a helpful assistant" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("merges multiple system messages with double newlines", () => {
    const wire = toCopilotMessages([
      new SystemMessage("rule one"),
      new SystemMessage("rule two"),
      new HumanMessage("question"),
    ]);
    expect(wire[0]).toEqual({
      role: "system",
      content: "rule one\n\nrule two",
    });
  });

  it("omits system role entirely when no system message is present", () => {
    const wire = toCopilotMessages([new HumanMessage("hi")]);
    expect(wire.find((m) => m.role === "system")).toBeUndefined();
  });

  it("serialises AIMessage tool_calls into the OpenAI assistant tool_calls shape", () => {
    const ai = new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "call_abc",
          name: "read_file",
          args: { path: "src/foo.ts" },
          type: "tool_call",
        },
      ],
    });
    const wire = toCopilotMessages([new HumanMessage("hi"), ai]);
    expect(wire[1]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_abc",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ path: "src/foo.ts" }),
          },
        },
      ],
    });
  });

  it("converts ToolMessage to the {role: tool, tool_call_id, content} shape Copilot expects", () => {
    const wire = toCopilotMessages([
      new HumanMessage("hi"),
      new ToolMessage({
        tool_call_id: "call_abc",
        content: "file contents here",
      }),
    ]);
    expect(wire[1]).toEqual({
      role: "tool",
      tool_call_id: "call_abc",
      content: "file contents here",
    });
  });
});

describe("toOpenAITools", () => {
  it("converts LangChain structured tools into OpenAI function-tool wire format", () => {
    const readFile = tool(async () => "ok", {
      name: "read_file",
      description: "Read a file from the worktree",
      schema: z.object({
        path: z.string().describe("Path relative to the worktree root"),
      }),
    });
    const [openaiTool] = toOpenAITools([readFile]);
    expect(openaiTool.type).toBe("function");
    expect(openaiTool.function.name).toBe("read_file");
    expect(openaiTool.function.description).toBe("Read a file from the worktree");
    expect(openaiTool.function.parameters).toMatchObject({
      type: "object",
      properties: { path: { type: "string" } },
    });
  });
});

describe("parseSseFrames", () => {
  it("returns each complete frame's data payload and an empty remainder", () => {
    const buffer = 'data: {"a":1}\n\ndata: {"b":2}\n\n';
    const { events, remainder } = parseSseFrames(buffer);
    expect(events).toEqual(['{"a":1}', '{"b":2}']);
    expect(remainder).toBe("");
  });

  it("keeps a trailing partial frame in the remainder for the next read", () => {
    const buffer = 'data: {"a":1}\n\ndata: {"b":';
    const { events, remainder } = parseSseFrames(buffer);
    expect(events).toEqual(['{"a":1}']);
    expect(remainder).toBe('data: {"b":');
  });

  it("normalises CRLF endings before splitting on the blank-line boundary", () => {
    const buffer = 'data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n';
    const { events } = parseSseFrames(buffer);
    expect(events).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("ignores comment lines and unrelated SSE fields inside a frame", () => {
    const buffer =
      ': keepalive\nevent: message\nid: 42\ndata: {"a":1}\n\n';
    const { events } = parseSseFrames(buffer);
    expect(events).toEqual(['{"a":1}']);
  });

  it("concatenates multiple data lines within one frame using newline (per SSE spec)", () => {
    const buffer = "data: line one\ndata: line two\n\n";
    const { events } = parseSseFrames(buffer);
    expect(events).toEqual(["line one\nline two"]);
  });

  it("handles the [DONE] sentinel as a regular data payload", () => {
    const buffer = "data: [DONE]\n\n";
    const { events } = parseSseFrames(buffer);
    expect(events).toEqual(["[DONE]"]);
  });
});

describe("extractCompletionDelta", () => {
  it("recognises the [DONE] sentinel and signals the loop to stop", () => {
    expect(extractCompletionDelta("[DONE]")).toEqual({
      content: "",
      done: true,
    });
  });

  it("extracts the content delta from a streaming completion frame", () => {
    const payload = JSON.stringify({
      choices: [{ delta: { content: "hello" } }],
    });
    expect(extractCompletionDelta(payload)).toEqual({
      content: "hello",
      usage: undefined,
      done: false,
    });
  });

  it("captures token usage when the server includes it on the final frame", () => {
    const payload = JSON.stringify({
      choices: [{ delta: {} }],
      usage: { prompt_tokens: 12, completion_tokens: 34 },
    });
    expect(extractCompletionDelta(payload)).toEqual({
      content: "",
      usage: { promptTokens: 12, completionTokens: 34 },
      done: false,
    });
  });

  it("returns null for malformed JSON so the stream can skip and continue", () => {
    expect(extractCompletionDelta("not json")).toBeNull();
  });

  it("treats a frame with no choices.delta.content as an empty content delta", () => {
    const payload = JSON.stringify({ choices: [{}] });
    expect(extractCompletionDelta(payload)).toEqual({
      content: "",
      usage: undefined,
      done: false,
    });
  });

  it("forwards a tool-call delta with id and name as a tool_call_chunk", () => {
    const payload = JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_abc",
                type: "function",
                function: { name: "read_file", arguments: "" },
              },
            ],
          },
        },
      ],
    });
    const delta = extractCompletionDelta(payload);
    expect(delta?.toolCallChunks).toEqual([
      { index: 0, id: "call_abc", name: "read_file", args: "" },
    ]);
    expect(delta?.content).toBe("");
  });

  it("forwards a follow-up tool-call delta carrying only argument fragments", () => {
    const payload = JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: '{"path":"src/foo.ts"}' } },
            ],
          },
        },
      ],
    });
    const delta = extractCompletionDelta(payload);
    expect(delta?.toolCallChunks).toEqual([
      { index: 0, id: undefined, name: undefined, args: '{"path":"src/foo.ts"}' },
    ]);
  });

  it("uses the array position as a fallback index when the server omits it", () => {
    const payload = JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { id: "call_a", function: { name: "tool_a", arguments: "" } },
              { id: "call_b", function: { name: "tool_b", arguments: "" } },
            ],
          },
        },
      ],
    });
    const delta = extractCompletionDelta(payload);
    expect(delta?.toolCallChunks?.map((c) => c.index)).toEqual([0, 1]);
  });
});
