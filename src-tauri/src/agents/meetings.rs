// Meeting summary + Q&A agent. Routes through the existing multi-provider
// dispatch so whichever LLM (Claude / Gemini / Copilot / Local) is currently
// active in Settings is the one that runs.

use super::dispatch;
use super::dispatch::AiContext;

/// Produce a structured analysis of a completed meeting.
///
/// Input: the full conversation text (with optional speaker labels and
/// timestamps the caller has pre-formatted), plus the user's current title
/// and tag list. Output: strict JSON with `summary`, `actionItems`, `decisions`,
/// `suggestedTitle`, `suggestedTags`.
#[tauri::command]
pub async fn summarize_meeting(
    app: tauri::AppHandle,
    transcript_text: String,
    current_title: String,
    current_tags_json: String,
) -> Result<String, String> {
    let (client, api_key) = dispatch::llm_client().await?;

    let system = "You are an assistant that reviews material from a meeting the user attended. \
        The input is EITHER (a) a recorded conversation produced by automatic speech-to-text — \
        possibly including speaker labels in the form \"Name: …\" or \"SPEAKER_00: …\" when \
        diarization has run; attribute quotes to those labels when present — OR (b) freeform \
        written notes the user typed during a meeting where audio could not be recorded. \
        Treat both inputs the same way: write a precise analysis the user can consult later. \
        Be concrete and faithful to what was said or written — do not invent facts, attendees, \
        or decisions. If the notes are very brief, your summary should be brief too.\n\n\
        IMPORTANT: Never use the word \"transcript\" in any output field. Refer to the \
        material as the meeting, the conversation, or the notes — whichever fits.\n\n\
        Return ONLY a JSON object, no markdown fences, matching this schema:\n\
        {\n\
          \"summary\": \"<2–4 sentence overview of what the meeting was about and what was concluded>\",\n\
          \"actionItems\": [\"<one concrete action item per string: who/what/when where mentioned>\", ...],\n\
          \"decisions\": [\"<one decision per string, stated plainly>\", ...],\n\
          \"perPerson\": [\n\
            {\n\
              \"name\": \"<speaker's name or label as it appears in the input>\",\n\
              \"summary\": \"<1–3 sentences covering what this person said: progress, plans, blockers, opinions>\",\n\
              \"actionItems\": [\"<concrete action item owned by or assigned to this person>\", ...]\n\
            }, ...\n\
          ],\n\
          \"suggestedTitle\": \"<a short descriptive title (≤ 8 words), or null to keep current>\",\n\
          \"suggestedTags\": [\"standup\"|\"planning\"|\"retro\"|\"1:1\"|\"other\", ...]\n\
        }\n\
        Leave an array empty if the input contains nothing of that kind. \
        Prefer `suggestedTags` from the enum above; only add a new tag if absolutely necessary.\n\n\
        Rules for `perPerson`:\n\
        - REQUIRED when the current tags include \"standup\" — produce one entry per person who spoke or whose update is captured in the notes, in the order they spoke.\n\
        - For other tags it is optional: include it only when individual contributions can be clearly attributed (named speaker labels, or a notes section where each person's update is clearly delimited). Otherwise leave it as [].\n\
        - Use the speaker's real name when given (\"Alice: …\" → \"Alice\"). For unnamed diarization clusters (\"SPEAKER_00: …\"), use that label verbatim. Do not invent names.\n\
        - Each person's `actionItems` must also appear in the top-level `actionItems` array — `perPerson` is a per-attendee view of the same items, not a separate list.\n\
        - If a person spoke but had no action items, set their `actionItems` to [].";

    let user = format!(
        "Current title: {current_title}\n\
        Current tags: {current_tags_json}\n\n\
        === MEETING CONTENT ===\n\
        {transcript_text}\n\n\
        Return the JSON object now."
    );

    dispatch::dispatch(
        &app,
        &client,
        &api_key,
        system,
        &user,
        2048,
        &AiContext::panel("meetings"),
    )
    .await
}

/// Multi-turn Q&A over a completed meeting's transcript. The caller sends the
/// full transcript as the context string and the running chat history as JSON.
/// Streams reply text to the `meetings-chat-stream` event.
#[tauri::command]
pub async fn chat_meeting(
    app: tauri::AppHandle,
    context_text: String,
    history_json: String,
) -> Result<String, String> {
    let (client, api_key) = dispatch::llm_client().await?;

    let system = format!(
        "You are helping the user recall details from a meeting they attended. You have \
        the full transcript (produced by automatic speech-to-text, so expect transcription \
        errors on proper nouns and technical terms).\n\n\
        {context_text}\n\n\
        Rules:\n\
        - Answer ONLY from the transcript. Quote the relevant portion when useful.\n\
        - If the answer is not in the transcript, say so plainly — do not speculate.\n\
        - Be concise. This is a conversation, not an essay.\n\
        - Speaker attribution: lines may be prefixed with a speaker label such as \"Name: …\" \
          (a named person) or \"SPEAKER_00: …\" (an unnamed cluster from diarization). When \
          asked who said something, use those labels directly. If a line has no prefix, the \
          speaker is unknown for that portion.\n\
        - Reply in plain prose. No JSON."
    );

    dispatch::dispatch_multi_streaming(
        &app,
        &client,
        &api_key,
        &system,
        &history_json,
        2048,
        "meetings-chat-stream",
        &AiContext::panel("meetings"),
    )
    .await
}
