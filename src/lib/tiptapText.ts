/**
 * Extract a markdown-flavoured plain text representation from a TipTap
 * document JSON string. Used wherever notes need to be fed into an AI agent
 * (summary, chat, retro) or rendered into a plain-text context block — all
 * of which expect human-readable text, not the editor's JSON shape.
 *
 * Legacy notes saved as plain text (before the rich editor was introduced)
 * pass through unchanged.
 */

interface DocNode {
  type?: string;
  content?: DocNode[];
  text?: string;
  attrs?: {
    level?: number;
    checked?: boolean;
    /** Mention extension stores the canonical name under `label`,
     *  with `id` carrying the same value for now (we don't have a
     *  separate id space for participants). */
    label?: string;
    id?: string | null;
  };
  marks?: Mark[];
}

interface Mark {
  type: string;
  attrs?: { href?: string };
}

export function extractTiptapPlainText(
  value: string | null | undefined,
): string {
  if (!value) return "";
  let doc: DocNode;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || parsed.type !== "doc") {
      return value.trim();
    }
    doc = parsed;
  } catch {
    // Not JSON — treat as legacy plain-text notes.
    return value.trim();
  }
  const lines: string[] = [];
  for (const child of doc.content ?? []) walkBlock(child, lines);
  return lines.join("\n").trim();
}

function walkBlock(node: DocNode, lines: string[]) {
  switch (node.type) {
    case "paragraph":
      lines.push(inline(node));
      return;
    case "heading": {
      const level = Math.min(Math.max(node.attrs?.level ?? 1, 1), 6);
      lines.push("#".repeat(level) + " " + inline(node));
      return;
    }
    case "bulletList":
      for (const li of node.content ?? []) {
        lines.push("- " + listItemText(li));
      }
      return;
    case "orderedList": {
      let i = 1;
      for (const li of node.content ?? []) {
        lines.push(`${i}. ${listItemText(li)}`);
        i++;
      }
      return;
    }
    case "taskList":
      for (const ti of node.content ?? []) {
        const checked = ti.attrs?.checked ? "x" : " ";
        lines.push(`- [${checked}] ${listItemText(ti)}`);
      }
      return;
    case "blockquote": {
      const inner: string[] = [];
      for (const child of node.content ?? []) walkBlock(child, inner);
      for (const ln of inner) lines.push("> " + ln);
      return;
    }
    case "codeBlock":
      lines.push("```");
      lines.push(inline(node));
      lines.push("```");
      return;
    case "horizontalRule":
      lines.push("---");
      return;
    default:
      if (node.content) for (const c of node.content) walkBlock(c, lines);
      return;
  }
}

// listItem and taskItem children are typically a single paragraph (sometimes
// nested lists). Flatten the immediate paragraphs into one line so the markdown
// renders cleanly; nested blocks would require a recursive indent strategy
// that we can add if/when notes start using nested structures.
function listItemText(item: DocNode): string {
  return (item.content ?? []).map(inline).join(" ").trim();
}

function inline(node: DocNode): string {
  // Mentions are atom nodes — they don't carry `text`, but they do
  // carry the participant's display name on `attrs.label`. Render as
  // `@<name>` so the AI agent sees a familiar form and so plain-text
  // search hits the same syntax the user typed.
  if (node.type === "mention") {
    const label = node.attrs?.label?.trim();
    return label ? `@${label}` : "";
  }
  if (typeof node.text === "string") {
    let t = node.text;
    if (node.marks) {
      // Render marks as markdown the AI can interpret as emphasis. Underline
      // has no native markdown syntax, so we drop it — the AI doesn't need
      // it for sentiment / importance signals. Link is rendered as a markdown
      // link so the URL is preserved in the agent's context.
      for (const m of node.marks) {
        if (m.type === "bold") t = `**${t}**`;
        else if (m.type === "italic") t = `*${t}*`;
        else if (m.type === "strike") t = `~~${t}~~`;
        else if (m.type === "highlight") t = `==${t}==`;
        else if (m.type === "code") t = `\`${t}\``;
        else if (m.type === "link" && m.attrs?.href) {
          t = `[${t}](${m.attrs.href})`;
        }
      }
    }
    return t;
  }
  if (Array.isArray(node.content)) {
    return node.content.map(inline).join("");
  }
  return "";
}

/**
 * Walk a TipTap notes document JSON string and collect every `mention`
 * node's label. Each label appears once even if mentioned multiple
 * times in the same doc (deduped, preserving first-occurrence order).
 *
 * Legacy plain-text notes have no Mention nodes — they return an empty
 * list. Per the design conversation, we don't regex-match `@\w+` in
 * plain text on purpose: the user wants to opt in by re-typing notes
 * with the new `@mention` UI, not surface stray mid-word `@`s.
 */
export function extractMentionLabels(value: string | null | undefined): string[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as DocNode).type !== "doc"
  ) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  walkForMentions(parsed as DocNode, out, seen);
  return out;
}

function walkForMentions(
  node: DocNode,
  out: string[],
  seen: Set<string>,
) {
  if (node.type === "mention") {
    const label = node.attrs?.label?.trim();
    if (label) {
      const key = label.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(label);
      }
    }
    return;
  }
  if (Array.isArray(node.content)) {
    for (const c of node.content) walkForMentions(c, out, seen);
  }
}
