import { describe, expect, it } from "vitest";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { resolveCodeAssistModel, toGeminiContents } from "./gemini-codeassist.js";

describe("gemini-codeassist model alias resolution", () => {
  it("translates *-latest aliases to concrete versions", () => {
    expect(resolveCodeAssistModel("gemini-flash-latest")).toBe("gemini-2.5-flash");
    expect(resolveCodeAssistModel("gemini-2.5-flash-latest")).toBe("gemini-2.5-flash");
    expect(resolveCodeAssistModel("gemini-pro-latest")).toBe("gemini-2.5-pro");
    expect(resolveCodeAssistModel("gemini-2.5-pro-latest")).toBe("gemini-2.5-pro");
    expect(resolveCodeAssistModel("gemini-flash-lite-latest")).toBe(
      "gemini-2.5-flash-lite",
    );
  });

  it("passes through concrete model IDs unchanged", () => {
    expect(resolveCodeAssistModel("gemini-2.5-flash")).toBe("gemini-2.5-flash");
    expect(resolveCodeAssistModel("gemini-2.5-pro")).toBe("gemini-2.5-pro");
    expect(resolveCodeAssistModel("custom-model-id")).toBe("custom-model-id");
  });
});

describe("gemini-codeassist message conversion", () => {
  it("separates system into its own field; uses 'model' role for AI messages", () => {
    const { system, contents } = toGeminiContents([
      new SystemMessage("be precise"),
      new HumanMessage("hi"),
      new AIMessage("hello"),
      new HumanMessage("more"),
    ]);
    expect(system).toBe("be precise");
    expect(contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "hello" }] },
      { role: "user", parts: [{ text: "more" }] },
    ]);
  });

  it("merges multiple system messages with double newlines", () => {
    const { system } = toGeminiContents([
      new SystemMessage("rule one"),
      new SystemMessage("rule two"),
    ]);
    expect(system).toBe("rule one\n\nrule two");
  });

  it("returns empty system string when no system message is present", () => {
    const { system } = toGeminiContents([new HumanMessage("hi")]);
    expect(system).toBe("");
  });
});
