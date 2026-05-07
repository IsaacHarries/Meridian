use serde_json::Value;

/// Recursively flatten an ADF node to plain text (formatting stripped).
/// Used for short diagnostic projections and table-cell scanning where
/// markdown sigils would just be noise. Rich-text fields shown in the UI
/// go through `collect_adf_markdown` instead.
pub(in crate::integrations::jira) fn collect_adf_text(node: &Value) -> String {
    // Leaf text node
    if let Some(text) = node.get("text").and_then(|t| t.as_str()) {
        return text.to_string();
    }
    // Block/inline node with children
    if let Some(content) = node.get("content").and_then(|c| c.as_array()) {
        let node_type = node.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let separator = match node_type {
            "paragraph" | "heading" | "bulletList" | "orderedList" | "listItem"
            | "blockquote" | "codeBlock" | "rule" | "tableCell" | "tableHeader"
            | "tableRow" | "table" => "\n",
            _ => " ",
        };
        return content
            .iter()
            .map(collect_adf_text)
            .collect::<Vec<_>>()
            .join(separator);
    }
    String::new()
}

/// Walk an ADF tree and emit a markdown projection that preserves the
/// formatting JIRA renders visually:
///   - inline marks: strong (`**…**`), em (`*…*`), code (`` `…` ``),
///     strike (`~~…~~`), link (`[text](href)`)
///   - block nodes: heading (`#`–`######`), bullet/ordered lists with
///     nesting indent, blockquote (`> …`), code block fences, horizontal
///     rule (`---`), media (`![alt](attachment-url)`)
/// Anything not modelled falls back to its concatenated child text so
/// unknown ADF extensions never silently disappear. Used for the
/// description, acceptance criteria, and any other rich-text custom
/// fields fetched from JIRA so the frontend's MarkdownBlock can render
/// them the way JIRA does.
pub(in crate::integrations::jira) fn collect_adf_markdown(node: &Value, base_url: &str) -> String {
    let mut out = String::new();
    render_adf_block(node, base_url, &mut out, 0);
    // Trim trailing whitespace but preserve internal blank lines.
    out.trim_end().to_string()
}

/// Wrapper around `collect_adf_markdown` that returns Some(trimmed)
/// for non-empty docs and None otherwise. Used by the field-extraction
/// path so callers can distinguish "field exists with content" from
/// "field is empty / missing".
pub(in crate::integrations::jira) fn extract_adf_markdown(node: &Value, base_url: &str) -> Option<String> {
    if node.is_null() || !node.is_object() {
        return None;
    }
    let md = collect_adf_markdown(node, base_url);
    let trimmed = md.trim().to_string();
    if trimmed.is_empty() { None } else { Some(trimmed) }
}

fn render_adf_block(node: &Value, base_url: &str, out: &mut String, list_depth: usize) {
    let node_type = node.get("type").and_then(|t| t.as_str()).unwrap_or("");

    match node_type {
        "doc" => {
            if let Some(content) = node.get("content").and_then(|c| c.as_array()) {
                for (i, child) in content.iter().enumerate() {
                    if i > 0 {
                        out.push_str("\n\n");
                    }
                    render_adf_block(child, base_url, out, list_depth);
                }
            }
        }
        "paragraph" => {
            render_adf_inline_children(node, base_url, out);
        }
        "heading" => {
            let level = node
                .get("attrs")
                .and_then(|a| a.get("level"))
                .and_then(|l| l.as_u64())
                .unwrap_or(2)
                .clamp(1, 6) as usize;
            out.push_str(&"#".repeat(level));
            out.push(' ');
            render_adf_inline_children(node, base_url, out);
        }
        "bulletList" | "orderedList" => {
            let ordered = node_type == "orderedList";
            if let Some(items) = node.get("content").and_then(|c| c.as_array()) {
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push('\n');
                    }
                    out.push_str(&"  ".repeat(list_depth));
                    if ordered {
                        out.push_str(&format!("{}. ", i + 1));
                    } else {
                        out.push_str("- ");
                    }
                    render_list_item(item, base_url, out, list_depth + 1);
                }
            }
        }
        "blockquote" => {
            let mut inner = String::new();
            if let Some(children) = node.get("content").and_then(|c| c.as_array()) {
                for (i, child) in children.iter().enumerate() {
                    if i > 0 {
                        inner.push_str("\n\n");
                    }
                    render_adf_block(child, base_url, &mut inner, list_depth);
                }
            }
            for (i, line) in inner.lines().enumerate() {
                if i > 0 {
                    out.push('\n');
                }
                out.push_str("> ");
                out.push_str(line);
            }
        }
        "codeBlock" => {
            let lang = node
                .get("attrs")
                .and_then(|a| a.get("language"))
                .and_then(|l| l.as_str())
                .unwrap_or("");
            out.push_str("```");
            out.push_str(lang);
            out.push('\n');
            if let Some(children) = node.get("content").and_then(|c| c.as_array()) {
                for child in children {
                    if let Some(t) = child.get("text").and_then(|t| t.as_str()) {
                        out.push_str(t);
                    }
                }
            }
            out.push('\n');
            out.push_str("```");
        }
        "rule" => {
            out.push_str("---");
        }
        "mediaSingle" | "mediaGroup" => {
            if let Some(children) = node.get("content").and_then(|c| c.as_array()) {
                for child in children {
                    render_adf_inline(child, base_url, out);
                }
            }
        }
        "blockCard" | "embedCard" => {
            // JIRA "smart link" rendered as a card on its own line. The
            // title / status / preview metadata is resolved client-side
            // by Atlassian's smart-card service and isn't carried in the
            // ADF, so the URL is the only thing we have. Emit it as a
            // plain markdown link so MarkdownBlock renders it as a
            // clickable URL instead of dropping the node entirely.
            if let Some(url) = node
                .get("attrs")
                .and_then(|a| a.get("url"))
                .and_then(|u| u.as_str())
            {
                if !url.is_empty() {
                    out.push_str(&format!("[{url}]({url})"));
                }
            }
        }
        _ => {
            // Unknown block — emit its text content so we don't drop
            // anything silently.
            render_adf_inline_children(node, base_url, out);
        }
    }
}

fn render_list_item(item: &Value, base_url: &str, out: &mut String, list_depth: usize) {
    if let Some(children) = item.get("content").and_then(|c| c.as_array()) {
        for (i, child) in children.iter().enumerate() {
            let child_type = child.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if i == 0 && child_type == "paragraph" {
                // First paragraph stays on the bullet line itself.
                render_adf_inline_children(child, base_url, out);
            } else if child_type == "bulletList" || child_type == "orderedList" {
                out.push('\n');
                render_adf_block(child, base_url, out, list_depth);
            } else {
                out.push('\n');
                out.push_str(&"  ".repeat(list_depth));
                render_adf_block(child, base_url, out, list_depth);
            }
        }
    }
}

fn render_adf_inline_children(node: &Value, base_url: &str, out: &mut String) {
    if let Some(children) = node.get("content").and_then(|c| c.as_array()) {
        for child in children {
            render_adf_inline(child, base_url, out);
        }
    }
}

fn render_adf_inline(node: &Value, base_url: &str, out: &mut String) {
    let node_type = node.get("type").and_then(|t| t.as_str()).unwrap_or("");

    match node_type {
        "text" => {
            let text = node.get("text").and_then(|t| t.as_str()).unwrap_or("");
            // Apply marks outside-in: each mark wraps the previous
            // result. Code is applied innermost so backticks don't fight
            // with surrounding `**` / `*` wrappers.
            let mut wrapped = text.to_string();
            if let Some(marks) = node.get("marks").and_then(|m| m.as_array()) {
                // Render in a stable order: code → strike → em → strong → link
                // so the outer-most syntax is the link wrap (which markdown
                // parsers handle most reliably even with nested marks).
                let order = ["code", "strike", "em", "strong", "link"];
                for mark_type in order {
                    for mark in marks {
                        if mark.get("type").and_then(|t| t.as_str()) != Some(mark_type) {
                            continue;
                        }
                        wrapped = match mark_type {
                            "code" => format!("`{}`", wrapped),
                            "strike" => format!("~~{}~~", wrapped),
                            "em" => format!("*{}*", wrapped),
                            "strong" => format!("**{}**", wrapped),
                            "link" => {
                                let href = mark
                                    .get("attrs")
                                    .and_then(|a| a.get("href"))
                                    .and_then(|h| h.as_str())
                                    .unwrap_or("");
                                if href.is_empty() {
                                    wrapped
                                } else {
                                    format!("[{}]({})", wrapped, href)
                                }
                            }
                            _ => wrapped,
                        };
                    }
                }
            }
            out.push_str(&wrapped);
        }
        "hardBreak" => {
            // Two trailing spaces + newline = a markdown line break that
            // doesn't start a new paragraph.
            out.push_str("  \n");
        }
        "inlineCard" => {
            // Inline JIRA "smart link" — the URL is the only data the
            // ADF carries; the rendered card title/icon comes from
            // Atlassian's smart-card service at view time. Surface as
            // a plain markdown link so the user at least sees a
            // clickable URL inline (instead of the whole node being
            // dropped by the unknown-inline fallback's recurse-into-
            // empty-children no-op).
            if let Some(url) = node
                .get("attrs")
                .and_then(|a| a.get("url"))
                .and_then(|u| u.as_str())
            {
                if !url.is_empty() {
                    out.push_str(&format!("[{url}]({url})"));
                }
            }
        }
        "media" | "mediaInline" => {
            if let Some(attrs) = node.get("attrs") {
                let id = attrs.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if !id.is_empty() {
                    let alt = attrs
                        .get("alt")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .unwrap_or("image");
                    let trimmed_base = base_url.trim_end_matches('/');
                    out.push_str(&format!(
                        "![{alt}]({trimmed_base}/rest/api/3/attachment/content/{id})"
                    ));
                }
            }
        }
        _ => {
            // Unknown inline — recurse so nested text still surfaces.
            render_adf_inline_children(node, base_url, out);
        }
    }
}

#[cfg(test)]
mod adf_markdown_tests {
    use super::*;
    use super::super::parsing::extract_field_text;
    use serde_json::json;

    const BASE: &str = "https://example.atlassian.net";

    fn doc(content: Value) -> Value {
        json!({ "type": "doc", "version": 1, "content": content })
    }

    #[test]
    fn paragraph_with_inline_marks() {
        let v = doc(json!([
            {
                "type": "paragraph",
                "content": [
                    { "type": "text", "text": "Hello " },
                    { "type": "text", "text": "world", "marks": [{ "type": "strong" }] },
                    { "type": "text", "text": " — " },
                    { "type": "text", "text": "italic", "marks": [{ "type": "em" }] },
                    { "type": "text", "text": " and " },
                    { "type": "text", "text": "code", "marks": [{ "type": "code" }] },
                ]
            }
        ]));
        assert_eq!(
            collect_adf_markdown(&v, BASE),
            "Hello **world** — *italic* and `code`"
        );
    }

    #[test]
    fn heading_levels() {
        let v = doc(json!([
            {
                "type": "heading",
                "attrs": { "level": 1 },
                "content": [{ "type": "text", "text": "Top" }]
            },
            {
                "type": "heading",
                "attrs": { "level": 3 },
                "content": [{ "type": "text", "text": "Sub" }]
            }
        ]));
        assert_eq!(collect_adf_markdown(&v, BASE), "# Top\n\n### Sub");
    }

    #[test]
    fn bullet_list_with_nested_list() {
        let v = doc(json!([
            {
                "type": "bulletList",
                "content": [
                    {
                        "type": "listItem",
                        "content": [
                            { "type": "paragraph", "content": [{ "type": "text", "text": "first" }] }
                        ]
                    },
                    {
                        "type": "listItem",
                        "content": [
                            { "type": "paragraph", "content": [{ "type": "text", "text": "second" }] },
                            {
                                "type": "bulletList",
                                "content": [
                                    {
                                        "type": "listItem",
                                        "content": [
                                            { "type": "paragraph", "content": [{ "type": "text", "text": "nested" }] }
                                        ]
                                    }
                                ]
                            }
                        ]
                    }
                ]
            }
        ]));
        assert_eq!(
            collect_adf_markdown(&v, BASE),
            "- first\n- second\n  - nested"
        );
    }

    #[test]
    fn ordered_list_numbers_from_one() {
        let v = doc(json!([
            {
                "type": "orderedList",
                "content": [
                    {
                        "type": "listItem",
                        "content": [
                            { "type": "paragraph", "content": [{ "type": "text", "text": "alpha" }] }
                        ]
                    },
                    {
                        "type": "listItem",
                        "content": [
                            { "type": "paragraph", "content": [{ "type": "text", "text": "beta" }] }
                        ]
                    }
                ]
            }
        ]));
        assert_eq!(collect_adf_markdown(&v, BASE), "1. alpha\n2. beta");
    }

    #[test]
    fn link_mark() {
        let v = doc(json!([
            {
                "type": "paragraph",
                "content": [
                    { "type": "text", "text": "see " },
                    {
                        "type": "text",
                        "text": "docs",
                        "marks": [{ "type": "link", "attrs": { "href": "https://example.com" } }]
                    }
                ]
            }
        ]));
        assert_eq!(
            collect_adf_markdown(&v, BASE),
            "see [docs](https://example.com)"
        );
    }

    #[test]
    fn code_block_preserves_language() {
        let v = doc(json!([
            {
                "type": "codeBlock",
                "attrs": { "language": "rust" },
                "content": [{ "type": "text", "text": "let x = 1;" }]
            }
        ]));
        assert_eq!(
            collect_adf_markdown(&v, BASE),
            "```rust\nlet x = 1;\n```"
        );
    }

    #[test]
    fn blockquote_prefixes_each_line() {
        let v = doc(json!([
            {
                "type": "blockquote",
                "content": [
                    {
                        "type": "paragraph",
                        "content": [
                            { "type": "text", "text": "line one" },
                            { "type": "hardBreak" },
                            { "type": "text", "text": "line two" }
                        ]
                    }
                ]
            }
        ]));
        let md = collect_adf_markdown(&v, BASE);
        // hardBreak emits "  \n" so we get two prefixed lines.
        assert!(md.starts_with("> line one"));
        assert!(md.contains("\n> line two"));
    }

    #[test]
    fn media_emits_attachment_url() {
        let v = doc(json!([
            {
                "type": "mediaSingle",
                "content": [
                    {
                        "type": "media",
                        "attrs": { "id": "abc-123", "alt": "diagram" }
                    }
                ]
            }
        ]));
        assert_eq!(
            collect_adf_markdown(&v, BASE),
            "![diagram](https://example.atlassian.net/rest/api/3/attachment/content/abc-123)"
        );
    }

    #[test]
    fn inline_card_renders_as_url_link() {
        let v = doc(json!([
            {
                "type": "paragraph",
                "content": [
                    { "type": "text", "text": "see " },
                    {
                        "type": "inlineCard",
                        "attrs": { "url": "https://acme.atlassian.net/browse/PROJ-42" }
                    },
                    { "type": "text", "text": " for context" }
                ]
            }
        ]));
        assert_eq!(
            collect_adf_markdown(&v, BASE),
            "see [https://acme.atlassian.net/browse/PROJ-42](https://acme.atlassian.net/browse/PROJ-42) for context"
        );
    }

    #[test]
    fn block_card_renders_as_standalone_url_link() {
        let v = doc(json!([
            {
                "type": "blockCard",
                "attrs": { "url": "https://example.com/report" }
            }
        ]));
        assert_eq!(
            collect_adf_markdown(&v, BASE),
            "[https://example.com/report](https://example.com/report)"
        );
    }

    #[test]
    fn smart_link_with_empty_url_is_dropped() {
        let v = doc(json!([
            {
                "type": "paragraph",
                "content": [
                    { "type": "text", "text": "before " },
                    { "type": "inlineCard", "attrs": { "url": "" } },
                    { "type": "text", "text": "after" }
                ]
            }
        ]));
        assert_eq!(collect_adf_markdown(&v, BASE), "before after");
    }

    #[test]
    fn extract_returns_none_for_empty_doc() {
        let v = doc(json!([]));
        assert_eq!(extract_adf_markdown(&v, BASE), None);
    }

    #[test]
    fn extract_field_text_uses_markdown_for_adf() {
        let v = json!({
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        { "type": "text", "text": "bold", "marks": [{ "type": "strong" }] }
                    ]
                }
            ]
        });
        assert_eq!(extract_field_text(&v, BASE), Some("**bold**".to_string()));
    }
}
