import * as readline from "node:readline";
import { runQuery as runClaudeQuery } from "./agent.js";
import { runGeminiQuery } from "./gemini.js";
import type { QueryRequest } from "./protocol.js";

// Redirect console.log to stderr so stdout stays clean for the JSON protocol.
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let req: QueryRequest;
  try {
    req = JSON.parse(trimmed) as QueryRequest;
  } catch {
    return;
  }

  const queryGenerator =
    req.provider === "gemini" ? runGeminiQuery(req) : runClaudeQuery(req);

  for await (const event of queryGenerator) {
    process.stdout.write(JSON.stringify(event) + "\n");
  }
});

// Keep alive until stdin closes.
process.stdin.resume();
