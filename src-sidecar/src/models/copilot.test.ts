import { describe, expect, it } from "vitest";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { toCopilotMessages } from "./copilot.js";

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
});
