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

