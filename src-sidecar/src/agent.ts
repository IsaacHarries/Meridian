import { query } from "@anthropic-ai/claude-agent-sdk";
import type { QueryRequest, SidecarEvent } from "./protocol.js";

export async function* runQuery(req: QueryRequest): AsyncGenerator<SidecarEvent> {
  // Build a single prompt string from the message history.
  // The system prompt is passed separately via systemPrompt option.
  const lastUserMessage = [...req.messages]
    .reverse()
    .find((m) => m.role === "user");

  if (!lastUserMessage) {
    yield { id: req.id, type: "error", message: "No user message in request." };
    return;
  }

  // For multi-turn history, prepend prior turns as context in the prompt.
  const priorTurns = req.messages.slice(0, req.messages.indexOf(lastUserMessage));
  const contextPrefix = priorTurns.length > 0
    ? priorTurns.map((m) => `${m.role}: ${m.content}`).join("\n\n") + "\n\n"
    : "";
  const prompt = contextPrefix + lastUserMessage.content;

  try {
    const session = query({
      prompt,
      options: {
        systemPrompt: req.system,
        model: req.model,
        cwd: req.cwd,
        resume: req.sessionId ?? undefined,
        permissionMode: "acceptEdits",
        allowedTools: ["Read", "Glob", "Grep"],
        // Use the system claude binary — it has keychain access; the SDK's vendored binary does not.
        // Do NOT pass env option: the SDK replaces process.env entirely when env is set,
        // which strips HOME/USER and breaks keychain lookups.
        pathToClaudeCodeExecutable: "/usr/local/bin/claude",
      },
    });

    for await (const event of session) {
      if (event.type === "assistant") {
        for (const block of event.message.content) {
          if (block.type === "text" && block.text) {
            yield { id: req.id, type: "text", delta: block.text };
          }
        }
      } else if (event.type === "result") {
        if (event.is_error) {
          const errors = "errors" in event ? event.errors.join("; ") : "Unknown error";
          yield { id: req.id, type: "error", message: errors };
        } else {
          yield {
            id: req.id,
            type: "result",
            sessionId: event.session_id,
            costUsd: event.total_cost_usd,
            inputTokens: event.usage.input_tokens,
            outputTokens: event.usage.output_tokens,
          };
        }
      }
    }
  } catch (err) {
    yield { id: req.id, type: "error", message: String(err) };
  }
}
