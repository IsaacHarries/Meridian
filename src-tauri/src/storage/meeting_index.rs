// Cross-meeting search index — SQLite-backed.
//
// One row per meeting transcript segment. FTS5 powers keyword search;
// an `embedding` BLOB column powers semantic search when local Ollama
// embeddings are available. Both retrieval modes can run independently
// — keyword always works (free, deterministic), semantic engages only
// for segments that have been embedded successfully.
//
// Embeddings are populated opportunistically: index_meeting writes
// every segment with a NULL embedding, and the background backfill
// loop drains those NULLs whenever Ollama is reachable. That decouples
// indexing latency from Ollama uptime — the user can record meetings
// with Ollama off, search them by keyword immediately, and semantic
// hits start landing as soon as Ollama is back.
//
// Layout choice: one shared SQLite file at `<app_data_dir>/meetings-index.sqlite`.
// We keep no transactional relationship with the JSON meeting files —
// the JSON store is the source of truth, and the index is rebuildable
// at any time via `reindex_meeting`. If the index file gets corrupted
// the user can delete it and reindex from Settings.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use rusqlite::{params, Connection, OptionalExtension};
use tauri::Manager;

use crate::commands::meetings::{MeetingKind, MeetingRecord};

/// Single shared index path, set during setup. Mirrors the pattern
/// used by preferences/credentials: a global path resolved once so
/// helpers don't have to thread an AppHandle through every call.
static INDEX_PATH: OnceLock<PathBuf> = OnceLock::new();
/// One Connection guarded by a Mutex. SQLite handles concurrent reads
/// at the C layer but we serialise writes to keep the FTS5 triggers
/// from racing with the backfill loop.
static CONN: OnceLock<Arc<Mutex<Connection>>> = OnceLock::new();

pub fn init_index_path(app: &tauri::AppHandle) {
    let dir = app
        .path()
        .app_data_dir()
        .expect("cannot resolve app data dir");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("meetings-index.sqlite");
    let _ = INDEX_PATH.set(path.clone());

    // Open + migrate eagerly so the first save_meeting / search call
    // doesn't pay schema-creation latency. A failure here logs but
    // doesn't panic — the rest of the app should keep working without
    // search.
    if let Err(e) = open_and_migrate(&path) {
        eprintln!("[meeting-index] init failed: {e}");
    }
}

fn open_and_migrate(path: &PathBuf) -> rusqlite::Result<()> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;

    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS segments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            meeting_id TEXT NOT NULL,
            meeting_title TEXT NOT NULL,
            meeting_started_at TEXT NOT NULL,
            segment_idx INTEGER NOT NULL,
            speaker TEXT,
            start_ms INTEGER NOT NULL,
            end_ms INTEGER NOT NULL,
            text TEXT NOT NULL,
            embedding BLOB,
            embedding_model TEXT,
            UNIQUE(meeting_id, segment_idx)
        );
        CREATE INDEX IF NOT EXISTS idx_segments_meeting ON segments(meeting_id);

        CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(
            text,
            content='segments',
            content_rowid='id',
            tokenize='porter unicode61'
        );

        CREATE TRIGGER IF NOT EXISTS segments_ai AFTER INSERT ON segments BEGIN
          INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS segments_ad AFTER DELETE ON segments BEGIN
          INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.id, old.text);
        END;
        CREATE TRIGGER IF NOT EXISTS segments_au AFTER UPDATE ON segments BEGIN
          INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.id, old.text);
          INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
        END;
        "#,
    )?;
    let _ = CONN.set(Arc::new(Mutex::new(conn)));
    Ok(())
}

fn conn() -> Result<Arc<Mutex<Connection>>, String> {
    CONN.get()
        .cloned()
        .ok_or_else(|| "meeting index not initialised".to_string())
}

/// Search hit returned to the frontend. Carries enough metadata to
/// render a clickable result (meeting title + timestamp) without a
/// second round-trip.
#[derive(serde::Serialize, Clone, Debug)]
pub struct SegmentHit {
    pub segment_id: i64,
    pub meeting_id: String,
    pub meeting_title: String,
    pub meeting_started_at: String,
    pub segment_idx: i64,
    pub speaker: Option<String>,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    /// Source of the hit so the UI can surface a reason ("keyword
    /// match" vs "semantic match"). Hybrid retrieval may set both.
    pub matched_keyword: bool,
    pub matched_semantic: bool,
    /// Similarity / rank score after normalisation. Higher is better.
    /// Best-effort — useful for ordering, not absolute calibration.
    pub score: f32,
}

/// Drop and re-add every segment for one meeting. Notes-mode meetings
/// land as a single row whose `text` is the full notes block; that
/// keeps queries simple at the cost of less granular jump-to behaviour
/// for notes (worthwhile — notes are typically short anyway).
pub fn index_meeting(record: &MeetingRecord) -> Result<(), String> {
    let arc = conn()?;
    let mut c = arc.lock().map_err(|e| format!("lock poisoned: {e}"))?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM segments WHERE meeting_id = ?1",
        params![record.id],
    )
    .map_err(|e| e.to_string())?;

    // Resolve speaker_id → friendly name when the user has renamed
    // diarised clusters. Unrecognised ids fall through verbatim so
    // searches against the cluster label still match.
    let speaker_name_for = |sid: &str| -> String {
        record
            .speakers
            .iter()
            .find(|s| s.id == sid)
            .and_then(|s| s.display_name.clone())
            .unwrap_or_else(|| sid.to_string())
    };

    let chunks: Vec<IndexChunk> = match record.kind {
        MeetingKind::Transcript => chunk_transcript(record, &speaker_name_for),
        MeetingKind::Notes => chunk_notes(record),
    };

    for (idx, chunk) in chunks.iter().enumerate() {
        if chunk.text.trim().is_empty() {
            continue;
        }
        // Persist the joined speaker list (if any) as the row's
        // `speaker` column — display in search results, but the
        // body of the text already inlines per-line speaker prefixes
        // for retrieval to key on.
        let speaker_col: Option<String> = if chunk.speakers.is_empty() {
            None
        } else {
            Some(chunk.speakers.join(", "))
        };
        tx.execute(
            r#"INSERT INTO segments
                (meeting_id, meeting_title, meeting_started_at,
                 segment_idx, speaker, start_ms, end_ms, text,
                 embedding, embedding_model)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, NULL)"#,
            params![
                record.id,
                record.title,
                record.started_at,
                idx as i64,
                speaker_col,
                chunk.start_ms,
                chunk.end_ms,
                chunk.text,
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Target chunk width in characters. ~800 chars ≈ ~200 tokens for
/// English prose — comfortably inside nomic-embed-text's input cap
/// while giving the embedding enough surrounding context to capture
/// topic and identity. Whisper segments alone are typically 30–80
/// chars, which is too narrow for useful semantic matching.
const CHUNK_TARGET_CHARS: usize = 800;

/// Wrapped chunk we'll persist as one row. Carries the speaker
/// vocabulary that appears in the chunk so the row's `speaker`
/// column reflects who spoke (display purposes); per-line speaker
/// labels live inside `text` so retrieval matches on them.
struct IndexChunk {
    text: String,
    speakers: Vec<String>,
    start_ms: i64,
    end_ms: i64,
}

impl IndexChunk {
    fn empty() -> Self {
        Self {
            text: String::new(),
            speakers: Vec::new(),
            start_ms: 0,
            end_ms: 0,
        }
    }
}

/// Roll up consecutive transcript segments until each chunk is at
/// least CHUNK_TARGET_CHARS wide, prefixing each contributing line
/// with its speaker's display name. Speaker name appearing in the
/// chunk body lets both FTS5 and the embedding match on identity —
/// this is the actual fix for "what did Ricky say" / "what did I
/// ask Ricky" failing to retrieve relevant material.
fn chunk_transcript<F>(record: &MeetingRecord, speaker_name_for: &F) -> Vec<IndexChunk>
where
    F: Fn(&str) -> String,
{
    let mut chunks: Vec<IndexChunk> = Vec::new();
    let mut current = IndexChunk::empty();
    let mut current_started = false;

    for seg in record.segments.iter() {
        let trimmed = seg.text.trim();
        if trimmed.is_empty() {
            continue;
        }
        let speaker = seg.speaker_id.as_deref().map(speaker_name_for);
        let line = match &speaker {
            Some(name) if !name.is_empty() => format!("{name}: {}", trimmed),
            _ => trimmed.to_string(),
        };
        if !current_started {
            current.start_ms = (seg.start_sec * 1000.0) as i64;
            current_started = true;
        }
        if !current.text.is_empty() {
            current.text.push('\n');
        }
        current.text.push_str(&line);
        current.end_ms = (seg.end_sec * 1000.0) as i64;
        if let Some(name) = speaker {
            if !name.is_empty() && !current.speakers.contains(&name) {
                current.speakers.push(name);
            }
        }

        if current.text.chars().count() >= CHUNK_TARGET_CHARS {
            chunks.push(std::mem::replace(&mut current, IndexChunk::empty()));
            current_started = false;
        }
    }
    if !current.text.is_empty() {
        chunks.push(current);
    }
    chunks
}

/// Notes-mode meetings are freeform text the user typed. We split on
/// blank-line paragraph boundaries first, accumulating until each
/// chunk crosses CHUNK_TARGET_CHARS. Falls back to a hard char-cut
/// for runs of dense text without paragraph breaks.
fn chunk_notes(record: &MeetingRecord) -> Vec<IndexChunk> {
    let raw = match record.notes.as_deref() {
        Some(s) if !s.trim().is_empty() => s,
        _ => return vec![],
    };
    // First pass: split on blank-line paragraphs.
    let paragraphs: Vec<&str> = raw
        .split("\n\n")
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();
    let mut chunks: Vec<IndexChunk> = Vec::new();
    let mut current = IndexChunk::empty();
    for p in paragraphs {
        let cur_len = current.text.chars().count();
        if cur_len > 0 && cur_len + p.chars().count() > CHUNK_TARGET_CHARS {
            chunks.push(std::mem::replace(&mut current, IndexChunk::empty()));
        }
        if !current.text.is_empty() {
            current.text.push_str("\n\n");
        }
        current.text.push_str(p);
        if current.text.chars().count() >= CHUNK_TARGET_CHARS {
            chunks.push(std::mem::replace(&mut current, IndexChunk::empty()));
        }
    }
    if !current.text.is_empty() {
        chunks.push(current);
    }

    // Second pass: any chunk that's *still* too long (a single
    // paragraph that's blown the budget) gets hard-split by char
    // count. Falls outside the natural paragraph rhythm but keeps
    // embeddings well within their input cap.
    let mut out: Vec<IndexChunk> = Vec::new();
    for c in chunks {
        if c.text.chars().count() <= CHUNK_TARGET_CHARS * 2 {
            out.push(c);
            continue;
        }
        for slice in split_long_text(&c.text, CHUNK_TARGET_CHARS) {
            out.push(IndexChunk {
                text: slice,
                speakers: Vec::new(),
                start_ms: 0,
                end_ms: 0,
            });
        }
    }
    out
}

fn split_long_text(text: &str, target_chars: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut buf = String::new();
    for word in text.split_whitespace() {
        if buf.chars().count() + word.chars().count() + 1 > target_chars && !buf.is_empty() {
            out.push(std::mem::take(&mut buf));
        }
        if !buf.is_empty() {
            buf.push(' ');
        }
        buf.push_str(word);
    }
    if !buf.is_empty() {
        out.push(buf);
    }
    out
}

pub fn delete_meeting_from_index(meeting_id: &str) -> Result<(), String> {
    let arc = conn()?;
    let c = arc.lock().map_err(|e| format!("lock poisoned: {e}"))?;
    c.execute(
        "DELETE FROM segments WHERE meeting_id = ?1",
        params![meeting_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Total / embedded segment counts for the Settings status display.
#[derive(serde::Serialize, Clone, Debug, Default)]
pub struct IndexStatus {
    pub total_segments: i64,
    pub embedded_segments: i64,
    pub meetings_indexed: i64,
}

pub fn index_status() -> Result<IndexStatus, String> {
    let arc = conn()?;
    let c = arc.lock().map_err(|e| format!("lock poisoned: {e}"))?;
    let total: i64 = c
        .query_row("SELECT COUNT(*) FROM segments", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let embedded: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM segments WHERE embedding IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let meetings: i64 = c
        .query_row("SELECT COUNT(DISTINCT meeting_id) FROM segments", [], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    Ok(IndexStatus {
        total_segments: total,
        embedded_segments: embedded,
        meetings_indexed: meetings,
    })
}

/// Pull the next batch of segments that haven't been embedded yet.
/// The backfill loop calls this on each tick; segments are returned
/// oldest-first so newer meetings don't starve older ones.
pub struct PendingSegment {
    pub id: i64,
    pub text: String,
}

pub fn pending_embeddings(limit: i64) -> Result<Vec<PendingSegment>, String> {
    let arc = conn()?;
    let c = arc.lock().map_err(|e| format!("lock poisoned: {e}"))?;
    let mut stmt = c
        .prepare(
            "SELECT id, text FROM segments WHERE embedding IS NULL ORDER BY id ASC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![limit], |r| {
            Ok(PendingSegment {
                id: r.get(0)?,
                text: r.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Record an embedding produced by the backfill loop. The caller has
/// already verified the embedding's dimensionality matches the model
/// it claims to be from; this layer just persists.
pub fn set_segment_embedding(
    segment_id: i64,
    embedding: &[f32],
    model: &str,
) -> Result<(), String> {
    let arc = conn()?;
    let c = arc.lock().map_err(|e| format!("lock poisoned: {e}"))?;
    let bytes = floats_to_bytes(embedding);
    c.execute(
        "UPDATE segments SET embedding = ?1, embedding_model = ?2 WHERE id = ?3",
        params![bytes, model, segment_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Wipe every embedding so the next backfill tick re-runs them under a
/// new model. Triggered when the user changes the embedding-model
/// preference — embeddings from different models aren't comparable.
pub fn clear_all_embeddings() -> Result<(), String> {
    let arc = conn()?;
    let c = arc.lock().map_err(|e| format!("lock poisoned: {e}"))?;
    c.execute(
        "UPDATE segments SET embedding = NULL, embedding_model = NULL",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// FTS5 keyword search. Returns up to `limit` segments ordered by
/// FTS5's bm25 score (lower is better — we negate so higher = better
/// in the API).
///
/// `meeting_ids`: when `Some`, restricts results to segments belonging
/// to those meetings (used by the `#tag` query syntax — the caller
/// resolves tags → meeting ids client-side and passes them through).
/// `Some(empty)` short-circuits to no results without hitting SQLite.
pub fn search_keyword(
    query: &str,
    limit: i64,
    meeting_ids: Option<&[String]>,
) -> Result<Vec<SegmentHit>, String> {
    if matches!(meeting_ids, Some(ids) if ids.is_empty()) {
        return Ok(vec![]);
    }
    let arc = conn()?;
    let c = arc.lock().map_err(|e| format!("lock poisoned: {e}"))?;
    let safe_query = sanitize_fts_query(query);
    if safe_query.trim().is_empty() {
        return Ok(vec![]);
    }
    // SQLite has no native array binding, so when the caller restricts
    // by meeting id we splice a parameterised IN-list into the SQL.
    // Each id still binds as a separate parameter — no string interp
    // of user data into the query.
    let (sql, params_vec): (String, Vec<rusqlite::types::Value>) = match meeting_ids {
        None => (
            r#"SELECT s.id, s.meeting_id, s.meeting_title, s.meeting_started_at,
                       s.segment_idx, s.speaker, s.start_ms, s.end_ms, s.text,
                       bm25(segments_fts) AS rank
               FROM segments s
               JOIN segments_fts f ON f.rowid = s.id
               WHERE segments_fts MATCH ?1
               ORDER BY rank ASC
               LIMIT ?2"#
                .to_string(),
            vec![safe_query.clone().into(), limit.into()],
        ),
        Some(ids) => {
            let placeholders = (0..ids.len())
                .map(|i| format!("?{}", i + 3))
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                r#"SELECT s.id, s.meeting_id, s.meeting_title, s.meeting_started_at,
                       s.segment_idx, s.speaker, s.start_ms, s.end_ms, s.text,
                       bm25(segments_fts) AS rank
               FROM segments s
               JOIN segments_fts f ON f.rowid = s.id
               WHERE segments_fts MATCH ?1
                 AND s.meeting_id IN ({placeholders})
               ORDER BY rank ASC
               LIMIT ?2"#
            );
            let mut p: Vec<rusqlite::types::Value> = vec![safe_query.clone().into(), limit.into()];
            for id in ids {
                p.push(id.clone().into());
            }
            (sql, p)
        }
    };
    let mut stmt = c.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params_vec), |r| {
            let rank: f64 = r.get(9)?;
            Ok(SegmentHit {
                segment_id: r.get(0)?,
                meeting_id: r.get(1)?,
                meeting_title: r.get(2)?,
                meeting_started_at: r.get(3)?,
                segment_idx: r.get(4)?,
                speaker: r.get(5)?,
                start_ms: r.get(6)?,
                end_ms: r.get(7)?,
                text: r.get(8)?,
                matched_keyword: true,
                matched_semantic: false,
                // bm25 returns negative scores where lower (more
                // negative) = better. Flip so larger = better and
                // bump into a positive range so merge math is sane.
                score: (-rank as f32).max(0.0001),
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Cosine-similarity scan over stored embeddings. Naive O(n) — fine
/// for the personal-app scale (<10k segments) and avoids depending on
/// the sqlite-vec extension.
///
/// `meeting_ids`: when `Some`, restricts the scan to segments belonging
/// to those meetings (used by the `#tag` query syntax). `Some(empty)`
/// short-circuits to no results without touching SQLite.
pub fn search_semantic(
    query_vec: &[f32],
    limit: i64,
    embedding_model: &str,
    meeting_ids: Option<&[String]>,
) -> Result<Vec<SegmentHit>, String> {
    if matches!(meeting_ids, Some(ids) if ids.is_empty()) {
        return Ok(vec![]);
    }
    let arc = conn()?;
    let c = arc.lock().map_err(|e| format!("lock poisoned: {e}"))?;
    // Push the tag filter into SQL so the cosine loop only sees the
    // restricted slice — saves embedding-blob deserialisation we'd
    // otherwise discard.
    let (sql, params_vec): (String, Vec<rusqlite::types::Value>) = match meeting_ids {
        None => (
            r#"SELECT id, meeting_id, meeting_title, meeting_started_at,
                       segment_idx, speaker, start_ms, end_ms, text, embedding
               FROM segments
               WHERE embedding IS NOT NULL AND embedding_model = ?1"#
                .to_string(),
            vec![embedding_model.to_string().into()],
        ),
        Some(ids) => {
            let placeholders = (0..ids.len())
                .map(|i| format!("?{}", i + 2))
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                r#"SELECT id, meeting_id, meeting_title, meeting_started_at,
                       segment_idx, speaker, start_ms, end_ms, text, embedding
               FROM segments
               WHERE embedding IS NOT NULL AND embedding_model = ?1
                 AND meeting_id IN ({placeholders})"#
            );
            let mut p: Vec<rusqlite::types::Value> = vec![embedding_model.to_string().into()];
            for id in ids {
                p.push(id.clone().into());
            }
            (sql, p)
        }
    };
    let mut stmt = c.prepare(&sql).map_err(|e| e.to_string())?;
    let mut hits: Vec<SegmentHit> = Vec::new();
    let q_norm = vector_norm(query_vec);
    if q_norm == 0.0 {
        return Ok(vec![]);
    }
    let mut rows = stmt
        .query(rusqlite::params_from_iter(params_vec))
        .map_err(|e| e.to_string())?;
    while let Some(r) = rows.next().map_err(|e| e.to_string())? {
        let blob: Vec<u8> = r.get(9).map_err(|e| e.to_string())?;
        let v = bytes_to_floats(&blob);
        if v.len() != query_vec.len() {
            continue; // dimensionality mismatch — model migration in flight
        }
        let sim = cosine_similarity(query_vec, &v, q_norm);
        hits.push(SegmentHit {
            segment_id: r.get(0).map_err(|e| e.to_string())?,
            meeting_id: r.get(1).map_err(|e| e.to_string())?,
            meeting_title: r.get(2).map_err(|e| e.to_string())?,
            meeting_started_at: r.get(3).map_err(|e| e.to_string())?,
            segment_idx: r.get(4).map_err(|e| e.to_string())?,
            speaker: r.get(5).map_err(|e| e.to_string())?,
            start_ms: r.get(6).map_err(|e| e.to_string())?,
            end_ms: r.get(7).map_err(|e| e.to_string())?,
            text: r.get(8).map_err(|e| e.to_string())?,
            matched_keyword: false,
            matched_semantic: true,
            score: sim,
        });
    }
    hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    hits.truncate(limit as usize);
    Ok(hits)
}

/// Look up one segment by its id (for the frontend's "open this hit"
/// flow — we send the user back to that meeting and scroll to the
/// segment).
pub fn get_segment(segment_id: i64) -> Result<Option<SegmentHit>, String> {
    let arc = conn()?;
    let c = arc.lock().map_err(|e| format!("lock poisoned: {e}"))?;
    let row = c
        .query_row(
            r#"SELECT id, meeting_id, meeting_title, meeting_started_at,
                       segment_idx, speaker, start_ms, end_ms, text
               FROM segments WHERE id = ?1"#,
            params![segment_id],
            |r| {
                Ok(SegmentHit {
                    segment_id: r.get(0)?,
                    meeting_id: r.get(1)?,
                    meeting_title: r.get(2)?,
                    meeting_started_at: r.get(3)?,
                    segment_idx: r.get(4)?,
                    speaker: r.get(5)?,
                    start_ms: r.get(6)?,
                    end_ms: r.get(7)?,
                    text: r.get(8)?,
                    matched_keyword: false,
                    matched_semantic: false,
                    score: 0.0,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn floats_to_bytes(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for f in v {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

fn bytes_to_floats(b: &[u8]) -> Vec<f32> {
    let mut out = Vec::with_capacity(b.len() / 4);
    for chunk in b.chunks_exact(4) {
        let arr: [u8; 4] = chunk.try_into().unwrap_or([0; 4]);
        out.push(f32::from_le_bytes(arr));
    }
    out
}

fn vector_norm(v: &[f32]) -> f32 {
    v.iter().map(|x| x * x).sum::<f32>().sqrt()
}

fn cosine_similarity(a: &[f32], b: &[f32], a_norm: f32) -> f32 {
    let b_norm = vector_norm(b);
    if a_norm == 0.0 || b_norm == 0.0 {
        return 0.0;
    }
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    dot / (a_norm * b_norm)
}

/// Convert a free-form user query into an FTS5 MATCH expression.
///
/// Two non-obvious things this does:
///
/// 1. **OR semantics, not AND.** FTS5's default is implicit AND across
///    terms, which means a 9-word natural-language question like
///    "what did I ask Ricky to work on last week" will only match
///    chunks containing *every* word — almost none, so the keyword
///    retriever returns nothing and only semantic search contributes
///    to the final ranking. We OR-join terms instead, then trust
///    bm25's IDF weighting to rank docs by their share of the *rare*
///    query terms (proper nouns get high IDF; common verbs don't).
///
/// 2. **Stopword removal.** Function words ("what", "did", "to", "the")
///    have near-zero IDF and just add noise. Stripping them sharpens
///    bm25's signal toward the actual content terms.
///
/// Falls back to the original word list if removing stopwords would
/// leave nothing — preserves the "all stopwords" edge case so we
/// still return *something* rather than degrading to an empty match.
fn sanitize_fts_query(q: &str) -> String {
    let words: Vec<String> = q
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c.is_whitespace() {
                c
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .map(|w| w.to_string())
        .collect();
    let content_words: Vec<&str> = words
        .iter()
        .filter(|w| !is_stopword(w))
        .map(String::as_str)
        .collect();
    let chosen: Vec<&str> = if content_words.is_empty() {
        // Pathological "all stopwords" case (e.g. "what is the?") —
        // keep the original tokens rather than returning empty so the
        // user still sees *some* keyword hits to compare against the
        // semantic ones.
        words.iter().map(String::as_str).collect()
    } else {
        content_words
    };
    if chosen.is_empty() {
        return String::new();
    }
    chosen.join(" OR ")
}

/// Common English stopwords — case-insensitive match against the
/// query's tokens. Kept short and conservative; we'd rather let a
/// few low-IDF words through than accidentally strip a meaningful
/// term someone genuinely searched for.
fn is_stopword(w: &str) -> bool {
    const STOPWORDS: &[&str] = &[
        "a", "an", "and", "are", "as", "at", "be", "but", "by", "did", "do",
        "does", "for", "from", "had", "has", "have", "he", "her", "here",
        "him", "his", "how", "i", "if", "in", "is", "it", "its", "me", "my",
        "no", "not", "of", "on", "or", "our", "she", "so", "than", "that",
        "the", "their", "them", "then", "there", "they", "this", "those",
        "to", "too", "us", "was", "we", "were", "what", "when", "where",
        "which", "who", "why", "will", "with", "would", "you", "your",
    ];
    let lower = w.to_ascii_lowercase();
    STOPWORDS.contains(&lower.as_str())
}
