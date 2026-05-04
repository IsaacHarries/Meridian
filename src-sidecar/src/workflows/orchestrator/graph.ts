// LangGraph assembly for the Implement-Ticket Orchestrator workflow.

import { END, START, StateGraph } from "@langchain/langgraph";
import { getCheckpointer } from "../../checkpointer.js";
import { makeChatNode } from "./nodes.js";
import { OrchestratorStateAnnotation } from "./state.js";
import type { OrchestratorNodeContext } from "./types.js";

export function buildOrchestratorGraph(ctx: OrchestratorNodeContext) {
  return new StateGraph(OrchestratorStateAnnotation)
    .addNode("chat", makeChatNode(ctx))
    .addEdge(START, "chat")
    .addEdge("chat", END)
    .compile({ checkpointer: getCheckpointer() });
}
