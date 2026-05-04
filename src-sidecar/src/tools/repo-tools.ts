// LangChain tools that the implementation/test-gen agents use to read and
// write the worktree. Each tool's `execute` callback dispatches a
// `tool.callback.request` event to the Rust backend, which performs the
// actual filesystem operation (sandboxed to the configured worktree path)
// and replies with the result.
//
// Tools are constructed per workflow run because they capture the workflow
// id + emit closure used to dispatch and correlate the IPC callbacks.

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { OutboundEvent } from "../protocol.js";
import { requestToolCallback } from "./bridge.js";

type Emitter = (event: OutboundEvent) => void;

export interface RepoToolsContext {
  workflowId: string;
  emit: Emitter;
}

const READ_FILE_DESCRIPTION =
  "Read a file from the worktree. Returns the file's contents as a string. " +
  "Use this before writing to understand the existing structure, or to inspect files referenced in the plan.";

const WRITE_FILE_DESCRIPTION =
  "Write a file in the worktree. Provide COMPLETE new content — partial content will overwrite the entire file. " +
  "Creates the file (and any missing parent directories) if it does not exist.";

const GLOB_DESCRIPTION =
  "Find files in the worktree matching a glob pattern (e.g. 'src/**/*.ts', '**/*.test.tsx'). " +
  "Returns relative paths from the worktree root, capped at 500 results.";

const GREP_DESCRIPTION =
  "Search file contents in the worktree with a regex (uses `git grep`). " +
  "Optionally pass `path` to restrict the search to a subdirectory. Returns up to 200 matches as 'path:line:content'.";

const DIFF_DESCRIPTION =
  "Get the unified diff of the worktree against its base branch. " +
  "Useful when the agent needs to verify what changes have already been written.";

export function makeRepoTools(ctx: RepoToolsContext) {
  // Emit a `progress` event tagged with the tool's first interesting
  // argument so the frontend can render a live activity strip ("→
  // read_repo_file src/server.ts"). Without this the only signal the
  // user has during a long implementation pass is the cumulative token
  // counter — which moves but doesn't tell them WHICH file the agent
  // is currently touching.
  const summariseInput = (toolName: string, input: unknown): string => {
    if (!input || typeof input !== "object") return "";
    const obj = input as Record<string, unknown>;
    if (toolName === "grep_repo_files") {
      const pattern = typeof obj.pattern === "string" ? obj.pattern : "";
      const path = typeof obj.path === "string" ? obj.path : undefined;
      return path ? `${pattern} (in ${path})` : pattern;
    }
    if (typeof obj.path === "string") return obj.path;
    if (typeof obj.pattern === "string") return obj.pattern;
    return "";
  };

  const callback = async (toolName: string, input: unknown) => {
    const arg = summariseInput(toolName, input);
    ctx.emit({
      id: ctx.workflowId,
      type: "progress",
      node: "tool",
      status: "started",
      data: { tool: { name: toolName, arg } },
    });
    try {
      const result = await requestToolCallback({
        workflowId: ctx.workflowId,
        tool: toolName,
        input,
        emit: ctx.emit,
      });
      ctx.emit({
        id: ctx.workflowId,
        type: "progress",
        node: "tool",
        status: "completed",
        data: { tool: { name: toolName, arg } },
      });
      return result;
    } catch (err) {
      ctx.emit({
        id: ctx.workflowId,
        type: "progress",
        node: "tool",
        status: "completed",
        data: {
          tool: {
            name: toolName,
            arg,
            error: err instanceof Error ? err.message : String(err),
          },
        },
      });
      throw err;
    }
  };

  const readRepoFile = tool(
    async ({ path }: { path: string }) => {
      const result = (await callback("read_repo_file", { path })) as { contents: string };
      return result.contents;
    },
    {
      name: "read_repo_file",
      description: READ_FILE_DESCRIPTION,
      schema: z.object({
        path: z.string().describe("Path relative to the worktree root, e.g. 'src/components/Button.tsx'"),
      }),
    },
  );

  const writeRepoFile = tool(
    async ({ path, content }: { path: string; content: string }) => {
      await callback("write_repo_file", { path, content });
      return `Wrote ${path}`;
    },
    {
      name: "write_repo_file",
      description: WRITE_FILE_DESCRIPTION,
      schema: z.object({
        path: z.string().describe("Path relative to the worktree root"),
        content: z.string().describe("The complete new file content"),
      }),
    },
  );

  const globRepoFiles = tool(
    async ({ pattern }: { pattern: string }) => {
      const result = (await callback("glob_repo_files", { pattern })) as { files: string[] };
      return result.files.join("\n");
    },
    {
      name: "glob_repo_files",
      description: GLOB_DESCRIPTION,
      schema: z.object({
        pattern: z.string().describe("Glob pattern, e.g. 'src/**/*.ts'"),
      }),
    },
  );

  const grepRepoFiles = tool(
    async ({ pattern, path }: { pattern: string; path?: string }) => {
      const result = (await callback("grep_repo_files", { pattern, path })) as {
        matches: string[];
      };
      return result.matches.join("\n");
    },
    {
      name: "grep_repo_files",
      description: GREP_DESCRIPTION,
      schema: z.object({
        pattern: z.string().describe("Regex pattern to search for"),
        path: z
          .string()
          .optional()
          .describe("Optional subdirectory to restrict the search"),
      }),
    },
  );

  const getRepoDiff = tool(
    async () => {
      const result = (await callback("get_repo_diff", {})) as { diff: string };
      return result.diff;
    },
    {
      name: "get_repo_diff",
      description: DIFF_DESCRIPTION,
      schema: z.object({}),
    },
  );

  return [readRepoFile, writeRepoFile, globRepoFiles, grepRepoFiles, getRepoDiff];
}

/** Run an arbitrary shell command inside the worktree and return its exit
 *  code + combined stdout/stderr. Used by the build-check sub-loop to invoke
 *  the user's configured build command. Not exposed as a regular agent tool
 *  because it's only meaningful for that one node. */
export async function execInWorktree(args: {
  workflowId: string;
  emit: Emitter;
  command: string;
  timeoutSecs?: number;
}): Promise<{ exitCode: number; output: string }> {
  const result = (await requestToolCallback({
    workflowId: args.workflowId,
    tool: "exec_in_worktree",
    input: { command: args.command, timeoutSecs: args.timeoutSecs ?? 180 },
    emit: args.emit,
    timeoutMs: (args.timeoutSecs ?? 180) * 1000 + 30_000,
  })) as { exitCode: number; output: string };
  return result;
}

/** Stat a worktree-relative path. Distinguishes missing from empty — used by
 *  the implementation node to verify what the agent actually did on disk
 *  after a per-file iteration. Not exposed as a LangChain tool because the
 *  agent itself doesn't need it; verification is the node's job. */
export async function statRepoFile(args: {
  workflowId: string;
  emit: Emitter;
  path: string;
}): Promise<{ exists: boolean; sizeBytes: number }> {
  const result = (await requestToolCallback({
    workflowId: args.workflowId,
    tool: "stat_repo_file",
    input: { path: args.path },
    emit: args.emit,
  })) as { exists: boolean; sizeBytes: number };
  return result;
}

/** Read a worktree-relative file via the IPC bridge. Mirrors the agent-facing
 *  read_repo_file tool but callable directly by node code (verification, etc.)
 *  without going through a LangChain tool invocation. */
export async function readRepoFileDirect(args: {
  workflowId: string;
  emit: Emitter;
  path: string;
}): Promise<string> {
  const result = (await requestToolCallback({
    workflowId: args.workflowId,
    tool: "read_repo_file",
    input: { path: args.path },
    emit: args.emit,
  })) as { contents: string };
  return result.contents;
}

export type RepoTools = ReturnType<typeof makeRepoTools>;
