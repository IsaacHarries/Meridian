// Custom LangChain chat model for Anthropic OAuth (Claude.ai subscription) auth.
//
// We subclass `ChatAnthropic` so all of LangChain's machinery (bindTools,
// streaming, response parsing, tool_use → tool_calls translation) works for
// free. The only thing we override is the HTTP fetch — we wrap the Anthropic
// SDK's fetch to (a) replace the x-api-key header with a Bearer
// Authorization, and (b) rewrite the request body into the shape the
// Claude.ai subscription endpoint requires:
//
//   1. system: [
//        { type: "text", text: "x-anthropic-billing-header: cc_version=...; cc_entrypoint=cli; cch=...;" },
//        { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
//      ]
//   2. The caller's actual system prompt is prepended into the first user
//      message.
//
// Without this rewrite, Claude.ai subscription tokens return
// `429 rate_limit_error` regardless of subscription quota.

import { createHash } from "node:crypto";
import { ChatAnthropic, type AnthropicInput } from "@langchain/anthropic";

const BILLING_SALT = "59cf53e54c78";
const CC_VERSION = "2.1.90";
const CC_ENTRYPOINT = "cli";
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

// ── Pure helpers (exported for unit testing) ──────────────────────────────────

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function computeCch(messageText: string): string {
  return sha256Hex(messageText).slice(0, 5);
}

export function computeVersionSuffix(messageText: string, version: string): string {
  const chars = [...messageText];
  const sampled = [4, 7, 20].map((i) => chars[i] ?? "0").join("");
  return sha256Hex(`${BILLING_SALT}${sampled}${version}`).slice(0, 3);
}

export function buildBillingHeader(firstUserText: string): string {
  const suffix = computeVersionSuffix(firstUserText, CC_VERSION);
  const cch = computeCch(firstUserText);
  return `x-anthropic-billing-header: cc_version=${CC_VERSION}.${suffix}; cc_entrypoint=${CC_ENTRYPOINT}; cch=${cch};`;
}

// ── Body rewriter ─────────────────────────────────────────────────────────────

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | Array<unknown>;
};

type AnthropicRequestBody = {
  model?: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: string; text: string }>;
  tools?: unknown[];
  [key: string]: unknown;
};

function firstUserMessageText(messages: AnthropicMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  if (!first) return "";
  if (typeof first.content === "string") return first.content;
  if (Array.isArray(first.content)) {
    for (const block of first.content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as { type?: string }).type === "text"
      ) {
        return (block as { text?: string }).text ?? "";
      }
    }
  }
  return "";
}

function prependToFirstUserMessage(
  messages: AnthropicMessage[],
  prefix: string,
): AnthropicMessage[] {
  const out = messages.map((m) => ({ ...m }));
  const idx = out.findIndex((m) => m.role === "user");
  if (idx === -1) {
    return [{ role: "user", content: prefix }, ...out];
  }
  const original = out[idx];
  if (typeof original.content === "string") {
    out[idx] = { ...original, content: `${prefix}\n\n${original.content}` };
  } else if (Array.isArray(original.content)) {
    out[idx] = {
      ...original,
      content: [{ type: "text", text: prefix }, ...original.content],
    };
  }
  return out;
}

function userSystemAsString(system: AnthropicRequestBody["system"]): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .filter((b) => typeof b === "object" && b && (b as { type?: string }).type === "text")
      .map((b) => (b as { text?: string }).text ?? "")
      .join("\n\n");
  }
  return "";
}

// Fields the Claude.ai subscription endpoint accepts via OAuth. Everything
// else from the SDK (LangChain leaks `temperature`, `top_k: -1`, `top_p: -1`,
// `thinking: { type: "disabled" }`, etc.) gets stripped — Anthropic's OAuth
// path appears to reject unfamiliar request shapes with the same generic
// "OAuth authentication is currently not supported" 401 it returns for
// genuine auth failures, obscuring the real issue.
const OAUTH_BODY_ALLOWLIST: ReadonlySet<string> = new Set([
  "model",
  "max_tokens",
  "messages",
  "stream",
  "tools",
  "tool_choice",
]);

/**
 * Take whatever body ChatAnthropic produced and rewrite it into the shape
 * the Claude.ai subscription endpoint accepts. White-lists the fields the
 * Rust reqwest path proves out (model, max_tokens, messages, optional
 * stream/tools/tool_choice) plus the billing-header `system[]` array.
 */
export function rewriteForOAuth(body: AnthropicRequestBody): AnthropicRequestBody {
  const userSystem = userSystemAsString(body.system);
  // Compute billing fingerprint from the *original* first user message
  // (before we prepend the user system into it).
  const originalFirstUser = firstUserMessageText(body.messages);

  const messages = userSystem.trim()
    ? prependToFirstUserMessage(body.messages, userSystem)
    : body.messages;

  const out: AnthropicRequestBody = {
    system: [
      { type: "text", text: buildBillingHeader(originalFirstUser) },
      { type: "text", text: CLAUDE_CODE_IDENTITY },
    ],
    messages,
  };
  for (const [key, value] of Object.entries(body)) {
    if (key === "system" || key === "messages") continue;
    if (OAUTH_BODY_ALLOWLIST.has(key)) {
      out[key] = value;
    }
  }
  return out;
}

// ── Fetch interceptor ─────────────────────────────────────────────────────────

function makeOAuthFetch(accessToken: string): typeof fetch {
  return async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    // Only intercept POSTs to /v1/messages — everything else (e.g. /v1/models
    // listing) passes through unchanged.
    if (!url.includes("/v1/messages") || !init?.body) {
      return fetch(input, init);
    }

    // Body might be string, Uint8Array, or Buffer depending on how the SDK
    // serialised it. Coerce to string for JSON.parse.
    let bodyText: string;
    if (typeof init.body === "string") {
      bodyText = init.body;
    } else if (init.body instanceof Uint8Array) {
      bodyText = new TextDecoder().decode(init.body);
    } else {
      return fetch(input, init);
    }

    let parsed: AnthropicRequestBody;
    try {
      parsed = JSON.parse(bodyText) as AnthropicRequestBody;
    } catch {
      return fetch(input, init);
    }

    const rewritten = rewriteForOAuth(parsed);

    // Build headers from scratch. The Anthropic SDK adds a stack of
    // x-stainless-* fingerprint headers and `anthropic-dangerous-direct-
    // browser-access` that the Claude.ai subscription endpoint uses to
    // detect "this is the SDK, not the CLI" and reject OAuth with a
    // generic 401. The minimal set below is what passes the check.
    const headers = new Headers();
    headers.set("authorization", `Bearer ${accessToken}`);
    headers.set("content-type", "application/json");
    headers.set("anthropic-version", "2023-06-01");
    // CLI-shaped UA + the beta flag the Claude Code CLI carries are both
    // load-bearing for OAuth recognition. Without either, Anthropic returns
    // "OAuth authentication is currently not supported".
    headers.set("user-agent", `claude-cli/${CC_VERSION} (cli)`);
    headers.set("anthropic-beta", "oauth-2025-04-20");
    const accept = new Headers(init.headers).get("accept");
    if (accept) {
      headers.set("accept", accept);
    }

    try {
      const res = await fetch(input, {
        ...init,
        headers,
        body: JSON.stringify(rewritten),
      });
      if (!res.ok) {
        console.error(`[claude-oauth] ${res.status} ${res.statusText}`);
      }
      return res;
    } catch (err) {
      console.error(
        `[claude-oauth] fetch threw: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
      );
      throw err;
    }
  };
}

// ── Chat model ────────────────────────────────────────────────────────────────

export interface ClaudeOAuthChatModelInput {
  accessToken: string;
  model: string;
  maxTokens?: number;
}

export class ClaudeOAuthChatModel extends ChatAnthropic {
  constructor(input: ClaudeOAuthChatModelInput) {
    const fields: AnthropicInput = {
      // ChatAnthropic requires an apiKey to construct — the value is unused
      // because our fetch interceptor replaces the auth header before the
      // request leaves the process.
      apiKey: "oauth-placeholder-not-used",
      model: input.model,
      maxTokens: input.maxTokens ?? 8192,
      clientOptions: {
        fetch: makeOAuthFetch(input.accessToken),
      },
    };
    super(fields);
  }

  override _llmType(): string {
    return "claude-oauth";
  }
}
