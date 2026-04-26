/**
 * Walk a TipTap notes document and pull out every taskItem node — flattened
 * into a list the Tasks panel can render. Each entry carries:
 *   - the task's plain text
 *   - its checked state
 *   - a `path` of content[] indices that uniquely locates the node in the
 *     doc tree, used by `setTaskCheckedAtPath` to toggle the source state
 *     without losing surrounding edits.
 *
 * Legacy plain-text notes (saved before the rich editor was introduced) and
 * malformed JSON return an empty list — they don't contain task structure.
 */

interface DocNode {
  type?: string;
  content?: DocNode[];
  text?: string;
  attrs?: { checked?: boolean };
}

export interface NotesTaskItem {
  /** Path of `content[]` indices from the doc root to the taskItem node. */
  path: number[];
  checked: boolean;
  /** Plain-text rendering of the task's content (paragraphs flattened). */
  text: string;
}

export function extractNotesTaskItems(value: string | null | undefined): NotesTaskItem[] {
  if (!value) return [];
  let doc: DocNode;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || parsed.type !== "doc") return [];
    doc = parsed;
  } catch {
    return [];
  }
  const out: NotesTaskItem[] = [];
  walk(doc, [], out);
  return out;
}

function walk(node: DocNode, path: number[], out: NotesTaskItem[]) {
  if (node.type === "taskItem") {
    out.push({
      path,
      checked: node.attrs?.checked === true,
      text: extractText(node).trim(),
    });
    // Don't descend into the taskItem's children — nested taskItems are
    // possible (TipTap supports it via TaskItem.configure({ nested: true })),
    // but we treat them as the parent's responsibility for now. Revisit if
    // users start nesting heavily.
    return;
  }
  if (Array.isArray(node.content)) {
    for (let i = 0; i < node.content.length; i++) {
      walk(node.content[i], [...path, i], out);
    }
  }
}

function extractText(node: DocNode): string {
  if (typeof node.text === "string") return node.text;
  if (!Array.isArray(node.content)) return "";
  return node.content.map(extractText).join("");
}

/**
 * Return a new TipTap doc JSON with the taskItem at `path` flipped to
 * `checked`. The original document is never mutated. If `path` doesn't
 * resolve to a taskItem (e.g. the underlying notes were edited and the
 * indices shifted), returns null so the caller can no-op gracefully.
 */
export function setTaskCheckedAtPath(
  notesJson: string,
  path: number[],
  checked: boolean,
): string | null {
  let doc: DocNode;
  try {
    doc = JSON.parse(notesJson);
  } catch {
    return null;
  }
  // Deep clone via JSON round-trip so we don't accidentally mutate the cached
  // copy held in the meetings store. Notes docs are small, this is cheap.
  const cloned: DocNode = JSON.parse(JSON.stringify(doc));
  let cursor: DocNode | undefined = cloned;
  for (const idx of path) {
    if (!cursor || !Array.isArray(cursor.content) || !cursor.content[idx]) {
      return null;
    }
    cursor = cursor.content[idx];
  }
  if (!cursor || cursor.type !== "taskItem") return null;
  cursor.attrs = { ...(cursor.attrs ?? {}), checked };
  return JSON.stringify(cloned);
}
