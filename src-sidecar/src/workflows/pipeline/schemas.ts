// Zod schemas owned by the pipeline workflow. Module-scoped here rather than
// next to `pipeline-schemas.ts` so the per-feature splits stay self-contained
// and circular imports between state.ts and node files are easy to avoid.

import { z } from "zod";

// ── Input schema ──────────────────────────────────────────────────────────────

export const PipelineInputSchema = z.object({
  ticketText: z.string(),
  ticketKey: z.string(),
  worktreePath: z.string(),
  codebaseContext: z.string().optional().default(""),
  /** JIRA issue type lower-cased ("bug", "story", …). Threaded through
   *  to the grooming node so it can omit the bug-specific rules block
   *  for non-bug runs. Optional; defaults to bug-rules-included when
   *  absent (see grooming.ts shouldIncludeBugRules). */
  ticketType: z.string().nullish(),
  groomingTemplates: z
    .object({
      acceptance_criteria: z.string().nullish(),
      steps_to_reproduce: z.string().nullish(),
    })
    .nullish(),
  skills: z
    .object({
      grooming: z.string().nullish(),
      patterns: z.string().nullish(),
      implementation: z.string().nullish(),
      review: z.string().nullish(),
      testing: z.string().nullish(),
    })
    .nullish(),
  prTemplate: z
    .object({
      body: z.string(),
      mode: z.enum(["guide", "strict"]).default("guide"),
    })
    .nullish(),
  /** Phase 3c — when true and `buildCheckCommand` is non-empty, the pipeline
   *  runs the build after implementation and loops back into a fix node on
   *  failure. Off by default; the user toggles it in Settings. */
  buildVerifyEnabled: z.boolean().optional().default(false),
  buildCheckCommand: z.string().optional().default(""),
  /** Per-attempt timeout for the build command in seconds. Default 300
   *  (5 min). Capped at 1800 in case the user typoed and entered hours. */
  buildCheckTimeoutSecs: z.number().int().positive().max(1800).optional().default(300),
  /** Max combined build+fix attempts before the pipeline gives up and
   *  surfaces the failure chain at the implementation checkpoint. */
  buildCheckMaxAttempts: z.number().int().positive().max(10).optional().default(3),
});

// ── Triage history entry (internal to PipelineStateAnnotation) ───────────────

export const TriageMessageInternalSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

// ── Per-file response from the implementation tool-loop ──────────────────────

// `summary` is treated as optional at the schema level because Gemini Flash
// frequently omits it even when the prompt mandates it; the implementation
// node synthesises a fallback summary when the file was actually written via
// write_repo_file.
export const PerFileResponseSchema = z.object({
  summary: z.string().optional().default(""),
  deviations: z.array(z.string()).optional().default([]),
  skipped: z.boolean().optional().default(false),
});

// ── Build-fix tool-loop final response ───────────────────────────────────────

export const BuildFixResponseSchema = z.object({
  summary: z.string().optional().default(""),
  files_written: z.array(z.string()).optional().default([]),
});
