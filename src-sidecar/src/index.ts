import * as readline from "node:readline";
import type { InboundMessage, OutboundEvent } from "./protocol.js";
import { resolveToolCallback } from "./tools/bridge.js";
import { cancelWorkflow, resumeWorkflow, rewindWorkflow, runWorkflow } from "./workflows/registry/lifecycle.js";

// Redirect non-protocol output away from stdout (which carries JSON only).
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

process.on("unhandledRejection", (reason) => {
  console.error("[sidecar:node] unhandledRejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[sidecar:node] uncaughtException:", err?.stack ?? err);
});

process.on("exit", (code) => {
  console.error(`[sidecar:node] process.exit code=${code}`);
});

process.on("beforeExit", (code) => {
  console.error(`[sidecar:node] beforeExit code=${code}`);
});

function emit(event: OutboundEvent): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg: InboundMessage;
  try {
    msg = JSON.parse(trimmed) as InboundMessage;
  } catch (err) {
    console.error("Failed to parse inbound message:", err);
    return;
  }

  switch (msg.type) {
    case "workflow.start":
      runWorkflow(msg, emit).catch((err) => {
        emit({ id: msg.id, type: "error", message: String(err) });
      });
      break;
    case "workflow.resume":
      resumeWorkflow(msg, emit).catch((err) => {
        emit({ id: msg.id, type: "error", message: String(err) });
      });
      break;
    case "workflow.rewind":
      rewindWorkflow(msg, emit).catch((err) => {
        emit({ id: msg.id, type: "error", message: String(err) });
      });
      break;
    case "workflow.cancel":
      cancelWorkflow(msg.id);
      break;
    case "tool.callback.response":
      resolveToolCallback(msg);
      break;
    default: {
      const _exhaustive: never = msg;
      console.error("Unknown inbound message:", _exhaustive);
    }
  }
});

process.stdin.resume();

// Node 25 + piped stdin sometimes decides the event loop is empty even with
// an active readline 'line' listener, firing `beforeExit` between workflow
// invocations. A simple ref'd interval anchors the loop until Rust closes
// stdin. The callback writes a heartbeat that's filtered out by the Rust
// log filter — keeps Node from optimising away an empty body.
let heartbeat = 0;
const keepalive = setInterval(() => {
  heartbeat++;
}, 30_000);
process.stdin.on("end", () => {
  clearInterval(keepalive);
  rl.close();
});
