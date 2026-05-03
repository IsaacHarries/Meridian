# Meetings RAG — current architecture & scaling plan

> Reference for the cross-meetings search and chat feature. Captures
> the design decisions made while building it, where the current
> system runs out of headroom, and the staged plan for upgrading as
> the corpus grows.
>
> Written 2026-04-30 with ~8 meetings indexed. Revisit this when
> corpus passes ~50, then ~150 meetings.

## What we have today

A local-first RAG pipeline over the user's recorded + notes meetings:

```
                     ┌────────────────────────────────────────────┐
                     │      meetings-index.sqlite (SQLite)        │
                     │  ────────────────────────────────────────  │
                     │  segments (one row per ~800-char chunk)    │
                     │   ├── text                                 │
                     │   ├── embedding BLOB (f32 LE bytes)        │
                     │   ├── embedding_model                      │
                     │   ├── speaker, start_ms, end_ms            │
                     │   └── meeting_id, title, started_at        │
                     │  segments_fts5 (FTS5 mirror of `text`)     │
                     └─────────────▲──────────────────────────────┘
                                   │
                       ┌───────────┴───────────┐
                       │                       │
            ┌──────────▼─────────┐  ┌──────────▼────────────┐
            │   write path       │  │      read path        │
            │   ──────────       │  │      ─────────        │
            │   save_meeting →   │  │  search_meetings →    │
            │   chunk + insert   │  │  FTS5 OR-query +      │
            │   (embedding NULL) │  │  cosine scan +        │
            │                    │  │  threshold filter     │
            │   backfill loop:   │  │                       │
            │   probes Ollama,   │  │  cross_meetings_chat  │
            │   drains pending   │  │  workflow synthesises │
            │   embeddings       │  │  answer w/ citations  │
            └────────────────────┘  └───────────────────────┘
```

### Components

| Layer | Implementation | Notes |
|---|---|---|
| Storage | SQLite + FTS5 (bundled rusqlite) | One file at `<dataDir>/meetings-index.sqlite`. Schema in `src-tauri/src/storage/meeting_index.rs`. |
| Chunking | ~800 chars per chunk, speaker-prefixed | `chunk_transcript` accumulates Whisper segments until target reached; `chunk_notes` splits on `\n\n` paragraphs. |
| Keyword retrieval | FTS5 with porter+unicode61 tokenizer | OR-joined terms after stopword removal. bm25 ranking. |
| Semantic retrieval | Naive cosine scan over BLOB column | Pure Rust, no extension. Microseconds at current scale. |
| Embedding generation | Ollama `/api/embed` (default `nomic-embed-text`, 768 dim) | Background backfill loop drains pending embeddings whenever Ollama is reachable. |
| Hybrid scoring | `max(raw_cosine, keyword_baseline=0.45)` + `0.10` hybrid bonus | See `meetings_search.rs` merge block for the calibration story. |
| Threshold filter | `min_score`, default 0.61 (saved pref, slider in Settings) | Calibrated for nomic-embed-text on conversational English. |
| Synthesis | `cross_meetings_chat` sidecar workflow | Takes top hits as context, instructs the model to cite by `[Title @ HH:MM:SS]`. |
| UX | `CrossMeetingsChatPanel` (right-side aside on Meetings panel) | Mode pills (broad/default/narrow), slash commands (`/strict`, `/broad`, `/experiment`, `/clear`, `/help`). |

### Key design decisions

- **Local-first.** Embeddings are produced by local Ollama. Indexed segments never leave the user's machine. Search results never go to a cloud provider.
- **Resilience to Ollama being off.** Indexing always succeeds with `embedding = NULL`. Backfill catches up later. Keyword search works at any time.
- **Hand-rolled cosine.** No `sqlite-vec`, no separate vector DB. Naive O(n) scan is fine at current scale and avoids a binary dependency.
- **Speaker name in indexed text.** Without prefixing, queries like "what did Ricky say" never matched because the speaker label lived in a separate column. Prefixing fixes both keyword and semantic retrieval.
- **OR + stopword removal in keyword queries.** FTS5's default AND breaks on natural-language questions (9-word query → almost no chunk contains all 9 words). bm25 with OR + IDF weighting naturally surfaces chunks containing rare query terms.

## Where the current system breaks down

Three orthogonal scaling concerns, with different breaking points:

| Scale | Chunks (est.) | What breaks first |
|---|---|---|
| ~50 meetings | ~1.5k | Nothing — system is snappy and reasonably precise |
| ~150 meetings | ~4.5k | **Precision** — same-topic meetings cluster in embedding space; threshold tuning gets harder per-query |
| ~500 meetings | ~15k | **Precision is bad enough that retrieval needs reranking**; naive scan starts taking 100–200 ms |
| ~1500+ meetings | ~50k+ | **Performance** — naive scan past 500 ms; time for HNSW |
| ~10k+ meetings | ~300k+ | Time for a real vector DB (LanceDB / Qdrant) |

**Performance is not the immediate concern.** Naive cosine over 15k 768-dim vectors is under 100 ms on M-series silicon. The bottleneck for years to come will be precision, not throughput.

Embeddings get worse at discriminating as the corpus densifies because:
- Bi-encoder embeddings are produced *in isolation* — query and document never see each other during inference.
- Conversational meeting prose has high baseline similarity (shared register, vocabulary, tone) regardless of topic.
- Identity-specific queries ("what did Ricky say") are particularly weak for bi-encoders — the embedding doesn't strongly encode names.

## Standard scalable RAG architecture

The industry-standard approach has three layers:

```
Query → [Recall: hybrid retrieval] → [Precision: reranker] → [Synthesis: chat model]
        FTS5 + bi-encoder cosine     cross-encoder            
        cheap, broad, top 50         expensive, top 8        
```

We currently have layer 1 (recall) and layer 3 (synthesis). Layer 2 (reranker) is what fixes the precision problem at scale because cross-encoders see the query and the candidate together — fundamentally more discriminative than cosine over independently-embedded vectors.

## Staged upgrade plan

### Stage 1 — soon (within first few weeks of real usage)

Two cheap wins that compound:

**1.1 Better embedding model.** Switch from `nomic-embed-text` (768 dim) to `mxbai-embed-large` (1024 dim). Both Ollama-native. Drop-in change in Settings → Meetings → Embedding model; hit Reindex; backfill re-embeds.

- Effort: 5 minutes of UI work
- Buys: meaningfully better discrimination, ~1 tier of corpus growth before the next change

**1.2 Query rewriting.** Before retrieval, send the user's question to the active chat model with a system prompt like *"rewrite this question into a keyword + topic phrase optimal for embedding search"*. Use the rewritten phrase for retrieval. User still sees their original question.

- "what did I ask Ricky to work on last week" → `Ricky tasks delegation work assignments`
- Helps both keyword recall (rare terms surface) and semantic matching (denser, topic-y signal)
- Cost: one extra cheap LLM call per query (~200 ms latency)
- Effort: ~30 minutes — new sidecar workflow + a wrapper around `searchMeetings`

These two together should buy 6+ months before reranking becomes pressing.

### Stage 2 — when corpus hits ~50–100 meetings (4k–6k chunks)

**2.1 Add a local reranker.** Cross-encoder model that scores `(query, chunk)` pairs after retrieval. Returns top 8–16 truly relevant from a candidate pool of 50.

Options ranked by deployment complexity:

- **Ollama-served reranker.** Cleanest if it works by then. Ollama added some reranker support in late 2024 but the API isn't standardized — check status when we get here.
- **Sidecar inference server.** Small Python process running [text-embeddings-inference](https://github.com/huggingface/text-embeddings-inference) (TEI). Mature, fast, minimal config. Adds one more process to manage.
- **Embedded ONNX inference in Rust.** Via `ort` (onnxruntime-rs) or `candle`. No new process; new dep surface; slower model iteration.

Recommended models:
- `bge-reranker-base` — ~1 GB, English-focused, strong quality/speed balance.
- `jina-reranker-v2` — ~500 MB, multilingual, slightly faster.

Architecture:
- `searchMeetings` returns top 50 candidates instead of top 16.
- New layer scores each candidate with the reranker.
- Top 8–16 reach the chat synthesis as context.

### Stage 3 — when corpus hits ~500+ meetings (15k+ chunks)

**3.1 Swap naive cosine for `sqlite-vec`.** Drop-in HNSW (approximate nearest neighbor) index over the same SQLite file. Sub-millisecond search at 100k+ vectors. Schema doesn't change — `embedding BLOB` is already the column `sqlite-vec` indexes.

Implementation: load the extension on connection open, replace `search_semantic` with a vector-index query. One Rust-side change.

### Stage 4 — when corpus hits 5k+ meetings (>2 years out at projected pace)

**4.1 Migrate to a dedicated local vector DB.** LanceDB or Qdrant Local. Different architecture entirely — separate process, different query API. Not worth planning for now; revisit if/when actually approached.

## Decision triggers

Watch for these signals and re-open this doc:

| Signal | Likely action |
|---|---|
| Threshold tuning feels query-dependent and tedious | Stage 1.2 (query rewriting) |
| Search returns plausibly-related but wrong meetings consistently | Stage 1.1 (better embed model) or 2.1 (reranker) |
| Search latency feels noticeable (>500 ms perceived) | Stage 3.1 (`sqlite-vec`) |
| Backfill takes hours to catch up after a meeting | Performance investigation; probably batching/parallelism, not architecture |
| You ever build "find every meeting that mentions X" for compliance review | Reranker becomes essential — false positives matter more |

## Things explicitly NOT planned

- **Cloud embedding APIs.** Local-first is a value. Even if OpenAI text-embedding-3-large would discriminate better, the cost is sending transcript snippets to a third party — declined.
- **A unified personal AI agent across all panels.** Rejected after scoping (see git log around 2026-04-30). Per-panel specialised chats won out.
- **Replacing the per-meeting chat with cross-meetings chat.** They're complementary surfaces, not redundant. Per-meeting still uses full-transcript-stuffing because it's better at full-conversation Q&A; cross-meetings uses retrieval because it has to.

## Files of interest

| Concern | File |
|---|---|
| Schema + chunking + cosine + FTS5 | `src-tauri/src/storage/meeting_index.rs` |
| Ollama embedding client + status probe | `src-tauri/src/llms/embeddings.rs` |
| Background backfill loop | `src-tauri/src/integrations/embedding_backfill.rs` |
| Hybrid scoring + threshold filter | `src-tauri/src/commands/meetings_search.rs` |
| AI traffic capture (debug panel sees embed calls too) | `src-tauri/src/integrations/ai_traffic.rs` |
| Sidecar synthesis workflow | `src-sidecar/src/workflows/cross-meetings-chat.ts` |
| UI (chat panel + mode pills + slash commands) | `src/components/CrossMeetingsChatPanel.tsx` |
| Settings card (embedding model, threshold slider, status) | `src/screens/SettingsScreen.tsx` (`CrossMeetingsSearchSection`) |
