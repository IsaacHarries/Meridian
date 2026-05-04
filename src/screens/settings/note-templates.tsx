import { RichNotesEditor } from "@/components/RichNotesEditor";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { extractTiptapPlainText } from "@/lib/tiptapText";
import { useMeetingsStore } from "@/stores/meetings/store";
import { NotebookPen } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function NoteTemplatesSection() {
  const tagVocab = useMeetingsStore((s) => s.tagVocab);
  const tagTemplates = useMeetingsStore((s) => s.tagTemplates);
  const setTagTemplate = useMeetingsStore((s) => s.setTagTemplate);

  const [selectedTag, setSelectedTag] = useState<string>(
    () => tagVocab[0] ?? "",
  );

  // Keep the selected tag valid as the vocabulary changes (tag deleted from
  // the Meetings panel, or the first tag added on a fresh setup).
  useEffect(() => {
    if (selectedTag && !tagVocab.includes(selectedTag)) {
      setSelectedTag(tagVocab[0] ?? "");
    } else if (!selectedTag && tagVocab.length > 0) {
      setSelectedTag(tagVocab[0]);
    }
  }, [selectedTag, tagVocab]);

  const hasTemplate = (t: string) =>
    extractTiptapPlainText(tagTemplates[t] ?? "").length > 0;

  if (tagVocab.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <NotebookPen className="h-4 w-4 text-muted-foreground" />
            Tag note templates
          </CardTitle>
          <CardDescription>
            Pre-fills a notes-mode meeting's body when its first tag is
            selected.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No tags yet. Add tags from the Meetings panel to associate templates
            here.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <NotebookPen className="h-4 w-4 text-muted-foreground" />
          Tag note templates
        </CardTitle>
        <CardDescription>
          When you select a tag for a notes-mode meeting and its body is empty,
          that tag's template is dropped in automatically. Only the first tag
          selected applies a template — adding more tags later won't replace
          existing notes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="note-template-tag">Tag</Label>
          <select
            id="note-template-tag"
            value={selectedTag}
            onChange={(e) => setSelectedTag(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {tagVocab.map((t) => (
              <option key={t} value={t}>
                {t}
                {hasTemplate(t) ? " · template set" : ""}
              </option>
            ))}
          </select>
        </div>
        {selectedTag && (
          <TagTemplateEditor
            key={selectedTag}
            tag={selectedTag}
            initialTemplate={tagTemplates[selectedTag] ?? ""}
            onSave={(content) => setTagTemplate(selectedTag, content)}
          />
        )}
        <p className="text-xs text-muted-foreground">
          Saves automatically when you click outside the editor or switch tags.
          Leave empty to skip the template for this tag.
        </p>
      </CardContent>
    </Card>
  );
}

// Why a separate component keyed on `tag`? The RichNotesEditor is uncontrolled
// after mount, so swapping its `value` mid-life only sometimes propagates (the
// editor bails when the new value is null/empty). Remounting on tag change is
// the simplest way to guarantee each tag's template loads cleanly.
function TagTemplateEditor({
  tag,
  initialTemplate,
  onSave,
}: {
  tag: string;
  initialTemplate: string;
  onSave: (content: string) => void;
}) {
  const notesLineHeight = useMeetingsStore((s) => s.notesLineHeight);
  const [draft, setDraft] = useState(initialTemplate);

  // Refs so the unmount cleanup sees the latest values without rerunning the
  // effect on every keystroke (which would also rerun the cleanup, causing
  // every keystroke to write to disk).
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const lastSavedRef = useRef(initialTemplate);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  function flush() {
    if (draftRef.current === lastSavedRef.current) return;
    lastSavedRef.current = draftRef.current;
    onSaveRef.current(draftRef.current);
  }

  // Save on unmount — covers the user switching tags (this component remounts
  // on key change), navigating away from Settings, or closing the panel.
  useEffect(() => {
    return () => {
      if (draftRef.current !== lastSavedRef.current) {
        onSaveRef.current(draftRef.current);
      }
    };
  }, []);

  return (
    <div className="rounded-md border h-[280px] flex flex-col overflow-hidden">
      <RichNotesEditor
        value={initialTemplate || null}
        onChange={setDraft}
        onBlur={flush}
        lineHeight={notesLineHeight}
        placeholder={`Template for "${tag}" notes. Use the toolbar for headings, lists, and checkboxes.`}
      />
    </div>
  );
}
