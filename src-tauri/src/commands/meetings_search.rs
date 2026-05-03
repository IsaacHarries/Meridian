// Hybrid search Tauri commands for the meetings index.
//
// `search_meetings` runs FTS5 keyword search and (when Ollama can
// produce a query embedding under the user's chosen model) cosine
// semantic search, then merges the two on segment id with a simple
// rank-fusion: keyword and semantic each contribute up to half the
// final score, so a hit that lands in both tops a hit that lands in
// only one. Results are deduped by segment so the UI shows one row
// per segment regardless of which retrievers fired.
//
// Failure modes are explicit in the response: `semantic_unavailable`
// is true when the user toggled semantic on but Ollama is down or
// the chosen model isn't installed. The UI surfaces this so the user
// knows their results are keyword-only and not silently degraded.

use std::collections::HashMap;

use crate::llms::embeddings::{
    embed_text_traced, probe_ollama, OllamaStatus, DEFAULT_EMBEDDING_MODEL,
};
use crate::storage::meeting_index::{
    get_segment, search_keyword, search_semantic, SegmentHit,
};
use crate::storage::preferences::get_pref;

#[derive(serde::Serialize, Clone, Debug)]
pub struct SearchResponse {
    pub hits: Vec<SegmentHit>,
    /// True when the caller asked for semantic search but Ollama
    /// wasn't ready. Hits will still contain keyword matches; the UI
    /// shows a banner explaining the gap.
    pub semantic_unavailable: bool,
    /// Reason string when semantic_unavailable is true.
    pub semantic_message: Option<String>,
    /// Echo of the model used for the semantic half — handy for debug
    /// log entries and surfacing "results from <model>" in the UI.
    pub embedding_model: String,
}

#[tauri::command]
pub async fn search_meetings(
    query: String,
    limit: Option<i64>,
    semantic: Option<bool>,
    min_score: Option<f32>,
    meeting_ids: Option<Vec<String>>,
) -> Result<SearchResponse, String> {
    let limit = limit.unwrap_or(20).clamp(1, 100);
    let want_semantic = semantic.unwrap_or(true);
    // Score floor in *raw cosine similarity* units — see the merge
    // block below for why we use cosine directly instead of a
    // normalised fusion score. Calibration for nomic-embed-text on
    // English conversational prose:
    //   ≥ 0.70  identical / paraphrase
    //   ≥ 0.55  on-topic, likely relevant
    //   ≥ 0.45  loosely related (same domain)
    //   < 0.45  noise
    //
    // Resolution order: explicit caller-supplied value → user
    // preference (Settings → Meetings → "Search relevance threshold")
    // → hard-coded default. Letting Rust read the pref itself avoids
    // having every search call site plumb the value through.
    let min_score = min_score
        .or_else(|| {
            crate::storage::preferences::get_pref("meetings_search_min_score")
                .and_then(|v| v.parse::<f32>().ok())
        })
        .unwrap_or(0.61)
        .clamp(0.0, 1.0);
    let model = get_pref("meetings_embedding_model")
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_EMBEDDING_MODEL.to_string());

    let id_slice = meeting_ids.as_deref();

    // Always run the keyword half — it's free and deterministic.
    let keyword_hits = search_keyword(&query, limit, id_slice)?;

    let mut semantic_hits: Vec<SegmentHit> = Vec::new();
    let mut semantic_unavailable = false;
    let mut semantic_message: Option<String> = None;

    if want_semantic {
        // Probe before embedding so we can fail fast with a clear
        // message instead of swallowing an opaque embed error.
        let probe = probe_ollama(&model).await;
        if probe.status != OllamaStatus::Available {
            semantic_unavailable = true;
            semantic_message = probe.message;
        } else {
            match embed_text_traced(&query, &model, "meetings_index", "embed_query").await {
                Ok(qvec) => match search_semantic(&qvec, limit, &model, id_slice) {
                    Ok(h) => semantic_hits = h,
                    Err(e) => {
                        semantic_unavailable = true;
                        semantic_message = Some(format!("semantic search failed: {e}"));
                    }
                },
                Err(e) => {
                    semantic_unavailable = true;
                    semantic_message = Some(format!("query embed failed: {e}"));
                }
            }
        }
    }

    // ── Merge ──────────────────────────────────────────────────────────────
    //
    // Score model: use raw cosine for semantic hits, a flat baseline
    // for keyword-only hits, and a small bonus when both retrievers
    // agree.
    //
    // Why raw cosine instead of a normalised fusion score: the previous
    // version divided each retriever's scores by their max, which
    // compressed everything into a narrow band proportional to the
    // *spread* of hits, not their absolute relevance. With ~800-char
    // chunks under nomic-embed-text, cosine values for English prose
    // tightly cluster around 0.45–0.85, and dividing by max made the
    // 16th-ranked hit score 90%+ of the 1st-ranked even when the
    // content was unrelated. Raw cosine is an absolute relevance
    // measure — keep it.
    //
    // Why bm25 → flat baseline: bm25 scores depend on document length,
    // term frequency, and corpus stats in ways that don't translate
    // to "how relevant is this hit" the way cosine does. Treating
    // every keyword-only match as a flat 0.45 (just below the
    // "likely relevant" threshold) acknowledges that FTS5 found
    // *something* without overstating it.
    const KEYWORD_BASELINE: f32 = 0.45;
    const HYBRID_BONUS: f32 = 0.10;

    let mut by_id: HashMap<i64, SegmentHit> = HashMap::new();
    for mut h in keyword_hits {
        h.score = KEYWORD_BASELINE;
        by_id.insert(h.segment_id, h);
    }
    for h in semantic_hits {
        let cosine = h.score; // already raw cosine from search_semantic
        match by_id.get_mut(&h.segment_id) {
            Some(existing) => {
                // Both retrievers fired on this segment — strong
                // signal. Take the cosine score and bump it slightly,
                // capped at 1.0 so the displayed score stays within
                // the documented colour-band ranges.
                existing.matched_semantic = true;
                existing.score = (cosine + HYBRID_BONUS).min(1.0);
            }
            None => {
                let mut sh = h;
                sh.score = cosine;
                by_id.insert(sh.segment_id, sh);
            }
        }
    }

    let mut hits: Vec<SegmentHit> = by_id
        .into_values()
        // Drop weak matches before sorting. "Weak" is anything below
        // min_score in our fused space — the long tail of generically-
        // similar chunks that aren't actually about the query.
        .filter(|h| h.score >= min_score)
        .collect();
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    hits.truncate(limit as usize);

    Ok(SearchResponse {
        hits,
        semantic_unavailable,
        semantic_message,
        embedding_model: model,
    })
}

/// Look up one segment by id — used by the UI when the user clicks a
/// search hit and we need the surrounding context to scroll to.
#[tauri::command]
pub fn get_meeting_segment(segment_id: i64) -> Result<Option<SegmentHit>, String> {
    get_segment(segment_id)
}
