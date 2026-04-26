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
  attrs?: { level?: number; checked?: boolean };
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
