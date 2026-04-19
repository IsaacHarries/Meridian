import { GoogleGenerativeAI } from "@google/generative-ai";
import type { QueryRequest, SidecarEvent } from "./protocol.js";

export async function* runGeminiQuery(
  req: QueryRequest,
): AsyncGenerator<SidecarEvent> {
  const { id, model, messages, system, apiKey } = req;

  if (!apiKey) {
    yield {
      id,
      type: "error",
      message: "Gemini API Key or OAuth Token is required for the sidecar.",
    };
    return;
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const generativeModel = genAI.getGenerativeModel({
      model,
      systemInstruction: system
        ? { role: "system", parts: [{ text: system }] }
        : undefined,
    });

    const contents = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const result = await generativeModel.generateContentStream({ contents });

    for await (const chunk of result.stream) {
      const delta = chunk.text();
      if (delta) {
        yield { id, type: "text", delta };
      }
    }

    const response = await result.response;
    const usageMetadata = response.usageMetadata;

    yield {
      id,
      type: "result",
      sessionId: "",
      costUsd: 0,
      inputTokens: usageMetadata?.promptTokenCount ?? 0,
      outputTokens: usageMetadata?.candidatesTokenCount ?? 0,
    };
  } catch (err) {
    yield { id, type: "error", message: String(err) };
  }
}
