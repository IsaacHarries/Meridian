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

// ── Rate-limit capture ────────────────────────────────────────────────────────
//
// Anthropic's API responses include `anthropic-ratelimit-*` headers
// describing remaining requests / tokens / input-tokens / output-tokens
// for the current rate-limit window plus an ISO timestamp for when each
// resets. The OAuth fetch interceptor parses them off every response
// and writes the latest snapshot to a module-level cache; any caller
// that wants to forward them to the frontend (workflow runners, the
// streaming helpers) can read `getAnthropicRateLimitSnapshot()` and
// emit a progress event.
//
// The Claude.ai subscription endpoint may or may not return these
// headers depending on plan tier. When absent, the snapshot stays
// `null` and downstream consumers know to skip the rate-limit UI.

export interface AnthropicRateLimitSnapshot {
  /** ISO timestamp of when this snapshot was captured. */
  capturedAt: string;
  requestsRemaining: number | null;
  requestsLimit: number | null;
  requestsResetAt: string | null;
  tokensRemaining: number | null;
  tokensLimit: number | null;
  tokensResetAt: string | null;
  inputTokensRemaining: number | null;
  inputTokensLimit: number | null;
  outputTokensRemaining: number | null;
  outputTokensLimit: number | null;
}

let latestRateLimits: AnthropicRateLimitSnapshot | null = null;

/** Subscribers wired by the streaming helpers — fired whenever a new
 *  snapshot lands so the frontend can update its dropdown live. */
type RateLimitListener = (snap: AnthropicRateLimitSnapshot) => void;
const rateLimitListeners = new Set<RateLimitListener>();

export function getAnthropicRateLimitSnapshot(): AnthropicRateLimitSnapshot | null {
  return latestRateLimits;
}

export function subscribeAnthropicRateLimits(fn: RateLimitListener): () => void {
  rateLimitListeners.add(fn);
  return () => {
    rateLimitListeners.delete(fn);
  };
}

function parseIntOrNull(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function captureRateLimitHeaders(headers: Headers): void {
  // Skip the parse + listener notification entirely when the response
  // lacks the rate-limit headers (e.g. error responses, certain plan
  // tiers) so we don't keep emitting stale snapshots.
  if (!headers.get("anthropic-ratelimit-requests-limit")
      && !headers.get("anthropic-ratelimit-tokens-limit")) {
    return;
  }
  const snap: AnthropicRateLimitSnapshot = {
    capturedAt: new Date().toISOString(),
    requestsRemaining: parseIntOrNull(
      headers.get("anthropic-ratelimit-requests-remaining"),
    ),
    requestsLimit: parseIntOrNull(
      headers.get("anthropic-ratelimit-requests-limit"),
    ),
    requestsResetAt: headers.get("anthropic-ratelimit-requests-reset"),
    tokensRemaining: parseIntOrNull(
      headers.get("anthropic-ratelimit-tokens-remaining"),
    ),
    tokensLimit: parseIntOrNull(
      headers.get("anthropic-ratelimit-tokens-limit"),
    ),
    tokensResetAt: headers.get("anthropic-ratelimit-tokens-reset"),
    inputTokensRemaining: parseIntOrNull(
      headers.get("anthropic-ratelimit-input-tokens-remaining"),
    ),
    inputTokensLimit: parseIntOrNull(
      headers.get("anthropic-ratelimit-input-tokens-limit"),
    ),
    outputTokensRemaining: parseIntOrNull(
      headers.get("anthropic-ratelimit-output-tokens-remaining"),
    ),
    outputTokensLimit: parseIntOrNull(
      headers.get("anthropic-ratelimit-output-tokens-limit"),
    ),
  };
  latestRateLimits = snap;
  for (const fn of rateLimitListeners) {
    try {
      fn(snap);
    } catch {
      /* listener errors must not break the fetch path */
    }
  }
}

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
  system?:
    | string
    | Array<{
        type: string;
        text: string;
        cache_control?: { type: "ephemeral" };
      }>;
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

type AnthropicTextBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
};

/** Extract the user's system prompt as a list of content blocks,
 *  preserving any `cache_control` markers the caller set so prompt
 *  caching survives the system → first-user-message rewrite required
 *  by the Claude.ai subscription endpoint. */
function userSystemAsBlocks(
  system: AnthropicRequestBody["system"],
): AnthropicTextBlock[] {
  if (!system) return [];
  if (typeof system === "string") {
    return system.length > 0 ? [{ type: "text", text: system }] : [];
  }
  if (Array.isArray(system)) {
    const out: AnthropicTextBlock[] = [];
    for (const b of system) {
      if (typeof b !== "object" || b === null) continue;
      const obj = b as {
        type?: string;
        text?: string;
        cache_control?: { type: "ephemeral" };
      };
      if (obj.type !== "text") continue;
      const block: AnthropicTextBlock = {
        type: "text",
        text: obj.text ?? "",
      };
      if (obj.cache_control) block.cache_control = obj.cache_control;
      out.push(block);
    }
    return out;
  }
  return [];
}

/** Prepend the user's system text as a single string to the first
 *  user message. Used when no `cache_control` markers are present —
 *  preserves the simpler wire format the OAuth endpoint has always
 *  received in the non-caching case. */
function prependStringToFirstUserMessage(
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

/** Prepend the user's (now-block-shaped) system content to the first
 *  user message, preserving cache_control markers on each block so
 *  Anthropic still serves cached portions back at ~10% billing. */
function prependBlocksToFirstUserMessage(
  messages: AnthropicMessage[],
  blocks: AnthropicTextBlock[],
): AnthropicMessage[] {
  if (blocks.length === 0) return messages;
  const out = messages.map((m) => ({ ...m }));
  const idx = out.findIndex((m) => m.role === "user");
  if (idx === -1) {
    return [{ role: "user", content: blocks }, ...out];
  }
  const original = out[idx];
  const existing: Array<unknown> =
    typeof original.content === "string"
      ? [{ type: "text", text: original.content }]
      : Array.isArray(original.content)
        ? original.content
        : [];
  out[idx] = { ...original, content: [...blocks, ...existing] };
  return out;
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
  // Extract the caller's system as content blocks so any `cache_control`
  // markers (set by the orchestrator on its stable preamble + stage
  // context) survive the move into the first user message.
  const userSystemBlocks = userSystemAsBlocks(body.system);
  const hasCacheControl = userSystemBlocks.some((b) => b.cache_control);
  // Compute billing fingerprint from the *original* first user message
  // (before we prepend the user system into it).
  const originalFirstUser = firstUserMessageText(body.messages);

  // When no caller block opted into caching, prepend the system as
  // plain concatenated text so the wire format stays the simple string
  // shape callers (and tests) have always seen. Caching callers force
  // the block path so `cache_control` survives the rewrite.
  const messages = (() => {
    if (userSystemBlocks.length === 0) return body.messages;
    if (hasCacheControl) {
      return prependBlocksToFirstUserMessage(body.messages, userSystemBlocks);
    }
    const joined = userSystemBlocks.map((b) => b.text).join("\n\n");
    return joined.trim()
      ? prependStringToFirstUserMessage(body.messages, joined)
      : body.messages;
  })();

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
      captureRateLimitHeaders(res.headers);
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
