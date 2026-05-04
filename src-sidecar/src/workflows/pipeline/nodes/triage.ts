import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { buildModel } from "../../../models/factory.js";
import { TriageTurnOutputSchema } from "../../pipeline-schemas.js";
import { buildTriageSystem } from "../../pipeline-prompts.js";
import {
  buildContextText,
  formatTriageTurnAsMarkdown,
  streamAndParse,
} from "../helpers.js";
import type {
  PipelineGraphContext,
  PipelineState,
  TriageMessage,
} from "../state.js";

export function makeTriageNode(ctx: PipelineGraphContext) {
  return async function triageNode(
    state: PipelineState,
  ): Promise<Partial<PipelineState>> {
    const model = buildModel(state.model);
    const contextText = buildContextText(state);
    const system = buildTriageSystem(contextText);

    const seedHistory: TriageMessage[] =
      state.triageHistory.length === 0
        ? [
            {
              role: "user",
              content:
                "Kick off the triage discussion. Surface the candidate approaches and any decisions I need to make.",
            },
          ]
        : [];

    const conversation: TriageMessage[] = [...seedHistory, ...state.triageHistory];
    const messages = [
      new SystemMessage(system),
      ...conversation.map((m) =>
        m.role === "user" ? new HumanMessage(m.content) : new SystemMessage(m.content),
      ),
    ];

    const { parsed: turn, usage } = await streamAndParse({
      ctx,
      nodeName: "triage",
      model,
      messages,
      schema: TriageTurnOutputSchema,
    });

    // Render the structured turn as plain markdown for the chat history.
    // The raw model response is JSON wrapped in prose / fences; storing
    // that verbatim makes the triage panel show a JSON dump instead of
    // the agent's actual proposal. The structured form is still surfaced
    // via triageLastTurn for the checkpoint payload.
    const formatted = formatTriageTurnAsMarkdown(turn);

    return {
      triageHistory: [...seedHistory, { role: "assistant", content: formatted }],
      triageLastTurn: turn,
      usage,
    };
  };
}
