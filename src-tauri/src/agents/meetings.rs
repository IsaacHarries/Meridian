// Meeting summary + Q&A agent. Routes through the existing multi-provider
// dispatch so whichever LLM (Claude / Gemini / Copilot / Local) is currently
// active in Settings is the one that runs.

use super::dispatch;

/// Produce a structured analysis of a completed meeting.
///
/// Input: the full transcript (speaker-less — just the text, with optional
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

    let system = "You are an assistant that reviews a meeting transcript produced by live \
        speech-to-text (no speaker labels). Write a precise analysis the user can consult later. \
        Be concrete and faithful to the transcript — do not invent facts, attendees, or decisions.\n\n\
        Return ONLY a JSON object, no markdown fences, matching this schema:\n\
        {\n\
          \"summary\": \"<2–4 sentence summary of what the meeting was about and what was concluded>\",\n\
          \"actionItems\": [\"<one concrete action item per string: who/what/when where mentioned>\", ...],\n\
          \"decisions\": [\"<one decision per string, stated plainly>\", ...],\n\
          \"suggestedTitle\": \"<a short descriptive title (≤ 8 words), or null to keep current>\",\n\
          \"suggestedTags\": [\"standup\"|\"planning\"|\"retro\"|\"1:1\"|\"other\", ...]\n\
        }\n\
        Leave an array empty if the transcript contains nothing of that kind. \
        Prefer `suggestedTags` from the enum above; only add a new tag if absolutely necessary.";

    let user = format!(
        "Current title: {current_title}\n\
        Current tags: {current_tags_json}\n\n\
        === TRANSCRIPT ===\n\
        {transcript_text}\n\n\
        Return the JSON object now."
    );

    dispatch::dispatch(&app, &client, &api_key, system, &user, 2048).await
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
        the full transcript (produced by automatic speech-to-text — no speaker labels, possible \
        transcription errors on proper nouns and technical terms).\n\n\
        {context_text}\n\n\
        Rules:\n\
        - Answer ONLY from the transcript. Quote the relevant portion when useful.\n\
        - If the answer is not in the transcript, say so plainly — do not speculate.\n\
        - Be concise. This is a conversation, not an essay.\n\
        - The transcript has no speaker labels. If asked \"who said X\", explain that you \
          cannot attribute speakers, but point to where in the meeting it was said.\n\
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
    )
    .await
}
