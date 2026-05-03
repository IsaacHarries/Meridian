/**
 * Maximum context window (input tokens) for each known model, plus
 * per-provider fallbacks for models that aren't in the table.
 *
 * The HeaderModelPicker uses this to render a progress ring showing
 * how full the active model's context is. Values reflect the headline
 * limit Anthropic / Google / GitHub / Meta publish — actual usable
 * context can be smaller depending on output reservation, system
 * prompts, etc., but this is good enough for a "are we close to the
 * cap" signal.
 *
 * Update this map when a new model lands; an unknown model falls back
 * to the provider default below.
 */

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic
  "claude-opus-4-7": 200_000,
  "claude-opus-4-7-20251022": 200_000,
  "claude-opus-4-6": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-sonnet-4-6-20250929": 200_000,
  "claude-haiku-4-5": 200_000,
  "claude-haiku-4-5-20251001": 200_000,

  // Google Gemini
  "gemini-2.5-pro": 1_000_000,
  "gemini-2.5-flash": 1_000_000,
  "gemini-1.5-pro": 2_000_000,
  "gemini-1.5-flash": 1_000_000,

  // GitHub Copilot models
  "gpt-4.1": 1_000_000,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "claude-3.5-sonnet": 200_000,

  // Common Ollama models — keep names lowercase since Ollama is
  // case-insensitive but the lookup here is case-sensitive.
  "qwen3:32b": 128_000,
  "qwen2.5-coder": 128_000,
  "llama3.1": 128_000,
  "llama3.2": 128_000,
};

const PROVIDER_DEFAULT_CONTEXT: Record<string, number> = {
  claude: 200_000,
  gemini: 1_000_000,
  copilot: 128_000,
  local: 32_000,
};

/**
 * Look up the context window (input tokens) for a given provider+model.
 * Falls back to the provider default when the exact model id isn't in
 * the table, then to a conservative 32k floor as a last resort.
 */
export function getModelContextWindow(
  provider: string,
  model: string,
): number {
  if (model && model in MODEL_CONTEXT_WINDOWS) {
    return MODEL_CONTEXT_WINDOWS[model];
  }
  // Best-effort partial match — some providers append date suffixes
  // (e.g. `-20251022`) that aren't in the table but the base id is.
  if (model) {
    for (const [key, value] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
      if (model.startsWith(key) || key.startsWith(model)) return value;
    }
  }
  return PROVIDER_DEFAULT_CONTEXT[provider] ?? 32_000;
}
