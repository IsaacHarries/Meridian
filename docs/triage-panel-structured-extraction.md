# Triage Panel — Structured Extraction (deferred)

A future redesign of the Triage stage middle panel that replaces free-form
prose with a structured, scannable plan. Filed for later — Option A
(living-document layout) is what currently ships.

## Why

The Triage agent currently returns plain prose. The panel renders it as
markdown, which is readable but still requires the user to *read* the proposal
end-to-end every revision. With structured fields, the user can scan instead.
Each round updates named sections in place, so you see *what changed about
the plan*, not "another paragraph."

## Shape

Change `run_triage_turn` to return JSON instead of prose:

```json
{
  "message": "<one-line conversational reply for the chat>",
  "approach": "<2–4 sentence summary of how the work will be done>",
  "affected_files": [
    { "path": "src/foo/bar.ts", "reason": "needs the new validator" }
  ],
  "open_questions": ["<question to the engineer>"],
  "risks": ["<thing that might go wrong>"],
  "confidence": "low" | "medium" | "high"
}
```

The right-side chat keeps using `message`. The middle panel stops looking like
a transcript and renders the other fields as cards.

## Backend changes

- `src-tauri/src/agents/planning.rs` — `run_triage_turn` system prompt: switch
  from "Respond in plain text. Do NOT produce JSON." to a JSON schema spec
  similar to the grooming chat agent.
- `src-tauri/src/agents/planning.rs` — `finalize_implementation_plan` already
  consumes `triageHistory`; it now needs to read the `approach`/`affected_files`
  fields out of the latest assistant turn rather than treating each turn as
  free prose.

## Frontend changes

- `src/lib/tauri.ts` — add `TriageTurnOutput` interface.
- `src/stores/implementTicketStore.ts` — `runTriageStage` and `sendTriageMessage`
  parse the response with `parseAgentJson`, store the structured object alongside
  (or in place of) the raw text in `triageHistory[i].content`. Consider a parallel
  `triageTurns: TriageTurnOutput[]` array so the chat-panel section in the
  right-hand chat can keep showing `message` only.
- `src/screens/ImplementTicketScreen.tsx` — replace `TriagePanel` with sections:
  - **Approach** — short paragraph, prominent
  - **Affected files** — list with reasons
  - **Open questions** — amber-tinted card if non-empty
  - **Risks** — collapsible
  - **Confidence** — small badge near the header

  Each section updates in place across rounds; show a small "updated" indicator
  if it changed in the latest turn.

## Migration / fallback

Old sessions persisted in `storeCache` will have free-text `triageHistory`.
Either:
- Run `parseAgentJson` defensively and fall back to rendering the raw text in
  an "Approach" card when no JSON is parseable, or
- Bump a `triageSchemaVersion` field on the persisted session and clear old
  triage turns on load.

## Open questions for when we revisit this

- Should `finalize_implementation_plan` consume the structured fields directly
  (skip re-parsing) or keep treating triage as free-form context for that agent?
- Do we want a "diff against previous turn" indicator per section, or is "this
  changed" enough?
- Where does `confidence` flow next? Could feed into the impact-analysis risk
  level or gate auto-proceed.
