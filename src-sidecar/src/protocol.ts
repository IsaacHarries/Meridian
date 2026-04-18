export type QueryRequest = {
  id: string;
  type: "query";
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  model: string;
  cwd: string;
  sessionId?: string | null;
};

export type TextEvent = {
  id: string;
  type: "text";
  delta: string;
};

export type ResultEvent = {
  id: string;
  type: "result";
  sessionId: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
};

export type ErrorEvent = {
  id: string;
  type: "error";
  message: string;
};

export type SidecarEvent = TextEvent | ResultEvent | ErrorEvent;
