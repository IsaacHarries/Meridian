import { describe, expect, it } from "vitest";
import {
  buildBillingHeader,
  computeCch,
  computeVersionSuffix,
  rewriteForOAuth,
  sha256Hex,
} from "./anthropic-oauth.js";

describe("anthropic-oauth body rewriter", () => {
  it("computes a stable cch (5 hex chars from sha256 of first user text)", () => {
    const cch = computeCch("hello world");
    expect(cch).toMatch(/^[0-9a-f]{5}$/);
    expect(cch).toBe(sha256Hex("hello world").slice(0, 5));
  });

  it("computes a stable version suffix (3 hex chars)", () => {
    const suffix = computeVersionSuffix("hello world this is a longer prompt", "2.1.90");
    expect(suffix).toMatch(/^[0-9a-f]{3}$/);
  });

  it("handles short message text in version suffix without throwing", () => {
    const suffix = computeVersionSuffix("hi", "2.1.90");
    expect(suffix).toMatch(/^[0-9a-f]{3}$/);
  });

  it("emits a billing header with the expected shape", () => {
    const header = buildBillingHeader("first user message text");
    expect(header).toMatch(
      /^x-anthropic-billing-header: cc_version=2\.1\.90\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/,
    );
  });

  it("rewrites a string-system body into the OAuth array shape and prepends system to the first user message", () => {
    const out = rewriteForOAuth({
      model: "claude-opus-4-7",
      max_tokens: 1000,
      system: "You are an expert engineer.",
      messages: [{ role: "user", content: "Implement a tic-tac-toe game." }],
    });

    expect(Array.isArray(out.system)).toBe(true);
    expect((out.system as Array<{ text: string }>).length).toBe(2);
    expect((out.system as Array<{ text: string }>)[0].text).toMatch(
      /^x-anthropic-billing-header:/,
    );
    expect((out.system as Array<{ text: string }>)[1].text).toBe(
      "You are Claude Code, Anthropic's official CLI for Claude.",
    );
    expect(out.messages[0].content).toBe(
      "You are an expert engineer.\n\nImplement a tic-tac-toe game.",
    );
  });

  it("does not modify the first user message when no system is present", () => {
    const out = rewriteForOAuth({
      model: "claude-opus-4-7",
      max_tokens: 1000,
      messages: [{ role: "user", content: "Hello." }],
    });
    expect(out.messages[0].content).toBe("Hello.");
  });

  it("preserves the tools field when rewriting (so bindTools requests still carry tools)", () => {
    const tools = [{ name: "read_repo_file", input_schema: { type: "object" } }];
    const out = rewriteForOAuth({
      model: "claude-opus-4-7",
      max_tokens: 1000,
      system: "Sys",
      messages: [{ role: "user", content: "Hi" }],
      tools,
    });
    expect(out.tools).toEqual(tools);
  });

  it("computes the billing header from the original first user text, not the prefixed one", () => {
    const original = "Implement a tic-tac-toe game.";
    const userSystem = "You are an expert.";

    const a = rewriteForOAuth({
      model: "x",
      messages: [{ role: "user", content: original }],
    });
    const b = rewriteForOAuth({
      model: "x",
      system: userSystem,
      messages: [{ role: "user", content: original }],
    });

    expect((a.system as Array<{ text: string }>)[0].text).toBe(
      (b.system as Array<{ text: string }>)[0].text,
    );
  });

  it("handles array-shaped system blocks (LangChain sometimes emits these)", () => {
    const out = rewriteForOAuth({
      model: "x",
      system: [{ type: "text", text: "Be precise." }],
      messages: [{ role: "user", content: "ok" }],
    });
    expect(out.messages[0].content).toBe("Be precise.\n\nok");
    expect((out.system as Array<{ text: string }>)[1].text).toBe(
      "You are Claude Code, Anthropic's official CLI for Claude.",
    );
  });

  it("inserts a user message if no user message exists", () => {
    const out = rewriteForOAuth({
      model: "x",
      system: "Sys",
      messages: [{ role: "assistant", content: "previous" }],
    });
    expect(out.messages[0]).toEqual({ role: "user", content: "Sys" });
    expect(out.messages[1]).toEqual({ role: "assistant", content: "previous" });
  });

  it("preserves cache_control markers when prepending system to the first user message", () => {
    const out = rewriteForOAuth({
      model: "x",
      system: [
        {
          type: "text",
          text: "long stable preamble",
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: "What changed?" }],
    });

    // Caching path forces the first user message into block form so the
    // ephemeral marker rides along with the cached text.
    expect(Array.isArray(out.messages[0].content)).toBe(true);
    const blocks = out.messages[0].content as Array<{
      type: string;
      text: string;
      cache_control?: { type: "ephemeral" };
    }>;
    expect(blocks[0]).toEqual({
      type: "text",
      text: "long stable preamble",
      cache_control: { type: "ephemeral" },
    });
    expect(blocks[1]).toEqual({ type: "text", text: "What changed?" });
  });

  it("falls back to string concat when no block opted into caching", () => {
    const out = rewriteForOAuth({
      model: "x",
      system: [{ type: "text", text: "Be precise." }],
      messages: [{ role: "user", content: "ok" }],
    });

    // Non-caching callers still see the legacy concatenated-string shape
    // — minimises diff for the common path and keeps prior tests green.
    expect(out.messages[0].content).toBe("Be precise.\n\nok");
  });
});
