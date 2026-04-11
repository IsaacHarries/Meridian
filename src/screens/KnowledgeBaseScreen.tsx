import { useEffect, useState, useCallback } from "react";
import {
  ArrowLeft,
  Plus,
  Search,
  Trash2,
  Edit2,
  Copy,
  Check,
  Download,
  BookOpen,
  Layers,
  Lightbulb,
  Tag,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  type KnowledgeEntry,
  loadKnowledgeEntries,
  saveKnowledgeEntry,
  deleteKnowledgeEntry,
  exportKnowledgeMarkdown,
} from "@/lib/tauri";

interface KnowledgeBaseScreenProps {
  onBack: () => void;
}

// ── Tag config ────────────────────────────────────────────────────────────────

const DECISION_TAGS = ["architecture", "security", "performance", "patterns", "conventions", "other"];

const TAG_COLOURS: Record<string, string> = {
  architecture: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  security: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  performance: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
  patterns: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
  conventions: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  other: "bg-muted text-muted-foreground",
};

function tagColour(tag: string) {
  return TAG_COLOURS[tag] ?? "bg-muted text-muted-foreground";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isoNow() {
  return new Date().toISOString();
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function entryTypeLabel(type: string) {
  if (type === "decision") return "Decision";
  if (type === "pattern") return "Pattern";
  return "Learning";
}

function entryTypeIcon(type: string) {
  if (type === "decision") return <BookOpen className="h-3.5 w-3.5" />;
  if (type === "pattern") return <Layers className="h-3.5 w-3.5" />;
  return <Lightbulb className="h-3.5 w-3.5" />;
}

// ── Entry editor dialog ───────────────────────────────────────────────────────

interface EditorProps {
  entry: KnowledgeEntry | null;
  defaultType: string;
  open: boolean;
  onClose: () => void;
  onSave: (entry: KnowledgeEntry) => Promise<void>;
}

function EntryEditor({ entry, defaultType, open, onClose, onSave }: EditorProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [linkedJiraKey, setLinkedJiraKey] = useState("");
  const [linkedPrId, setLinkedPrId] = useState("");
  const [saving, setSaving] = useState(false);

  // Reset fields when dialog opens
  useEffect(() => {
    if (!open) return;
    setTitle(entry?.title ?? "");
    setBody(entry?.body ?? "");
    setTagInput(entry?.tags.join(", ") ?? "");
    setLinkedJiraKey(entry?.linkedJiraKey ?? "");
    setLinkedPrId(entry?.linkedPrId?.toString() ?? "");
    setSaving(false);
  }, [open, entry]);

  async function handleSave() {
    if (!title.trim()) return;
    setSaving(true);
    const tags = tagInput
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const now = isoNow();
    await onSave({
      id: entry?.id ?? newId(),
      entryType: entry?.entryType ?? defaultType,
      title: title.trim(),
      body,
      tags,
      createdAt: entry?.createdAt ?? now,
      updatedAt: now,
      linkedJiraKey: linkedJiraKey.trim() || null,
      linkedPrId: linkedPrId ? parseInt(linkedPrId, 10) : null,
    });
    setSaving(false);
    onClose();
  }

  const isEdit = !!entry;
  const typeLabel = entryTypeLabel(entry?.entryType ?? defaultType);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit ${typeLabel}` : `New ${typeLabel}`}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="kb-title">Title</Label>
            <Input
              id="kb-title"
              placeholder="Short, descriptive title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="kb-body">Body (markdown supported)</Label>
            <Textarea
              id="kb-body"
              placeholder={
                defaultType === "decision"
                  ? "What was decided, why, alternatives considered, constraints..."
                  : defaultType === "pattern"
                  ? "What the pattern is, when to use it, examples..."
                  : "What was learned, context, recommended action..."
              }
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="min-h-[200px] font-mono text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="kb-tags" className="flex items-center gap-1.5">
              <Tag className="h-3.5 w-3.5" />
              Tags (comma-separated)
            </Label>
            {defaultType === "decision" && (
              <div className="flex flex-wrap gap-1.5 mb-1.5">
                {DECISION_TAGS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => {
                      const current = tagInput
                        .split(",")
                        .map((x) => x.trim())
                        .filter(Boolean);
                      if (current.includes(t)) {
                        setTagInput(current.filter((x) => x !== t).join(", "));
                      } else {
                        setTagInput([...current, t].join(", "));
                      }
                    }}
                    className={`px-2 py-0.5 rounded text-xs font-medium transition-opacity ${tagColour(t)} ${
                      tagInput.split(",").map((x) => x.trim()).includes(t) ? "opacity-100 ring-2 ring-offset-1 ring-primary" : "opacity-50 hover:opacity-80"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
            <Input
              id="kb-tags"
              placeholder="e.g. architecture, performance"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="kb-jira">Linked JIRA ticket (optional)</Label>
              <Input
                id="kb-jira"
                placeholder="e.g. PROJ-123"
                value={linkedJiraKey}
                onChange={(e) => setLinkedJiraKey(e.target.value.toUpperCase())}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="kb-pr">Linked PR ID (optional)</Label>
              <Input
                id="kb-pr"
                type="number"
                placeholder="e.g. 42"
                value={linkedPrId}
                onChange={(e) => setLinkedPrId(e.target.value)}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || !title.trim()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Entry card ────────────────────────────────────────────────────────────────

interface EntryCardProps {
  entry: KnowledgeEntry;
  onEdit: () => void;
  onDelete: () => void;
  onCopy: () => void;
  copied: boolean;
}

function EntryCard({ entry, onEdit, onDelete, onCopy, copied }: EntryCardProps) {
  const [expanded, setExpanded] = useState(false);
  const preview = entry.body.slice(0, 180) + (entry.body.length > 180 ? "…" : "");

  return (
    <Card className="hover:shadow-sm transition-shadow">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-muted-foreground shrink-0">{entryTypeIcon(entry.entryType)}</span>
            <CardTitle className="text-base leading-snug">{entry.title}</CardTitle>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onCopy} title="Copy as markdown">
              {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onEdit} title="Edit">
              <Edit2 className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-destructive hover:text-destructive"
              onClick={onDelete}
              title="Delete"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
          {entry.tags.map((tag) => (
            <span key={tag} className={`px-1.5 py-0.5 rounded text-xs font-medium ${tagColour(tag)}`}>
              {tag}
            </span>
          ))}
          {entry.linkedJiraKey && (
            <Badge variant="outline" className="text-xs gap-1">
              <ExternalLink className="h-3 w-3" />
              {entry.linkedJiraKey}
            </Badge>
          )}
          {entry.linkedPrId && (
            <Badge variant="outline" className="text-xs gap-1">
              PR #{entry.linkedPrId}
            </Badge>
          )}
          <span className="text-xs text-muted-foreground ml-auto">{formatDate(entry.createdAt)}</span>
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        {expanded ? (
          <pre className="text-sm text-muted-foreground whitespace-pre-wrap font-sans leading-relaxed">
            {entry.body}
          </pre>
        ) : (
          <p className="text-sm text-muted-foreground leading-relaxed">{preview}</p>
        )}
        {entry.body.length > 180 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="mt-1.5 text-xs text-primary hover:underline"
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </CardContent>
    </Card>
  );
}

// ── Entry list for a tab ──────────────────────────────────────────────────────

interface EntryListProps {
  entries: KnowledgeEntry[];
  search: string;
  activeTag: string | null;
  entryType: string;
  onEdit: (entry: KnowledgeEntry) => void;
  onDelete: (id: string) => void;
  copiedId: string | null;
  onCopy: (entry: KnowledgeEntry) => void;
  onNew: () => void;
  emptyLabel: string;
}

function EntryList({
  entries,
  search,
  activeTag,
  entryType,
  onEdit,
  onDelete,
  copiedId,
  onCopy,
  onNew,
  emptyLabel,
}: EntryListProps) {
  const q = search.toLowerCase();
  const filtered = entries
    .filter((e) => e.entryType === entryType)
    .filter((e) => !activeTag || e.tags.includes(activeTag))
    .filter(
      (e) =>
        !q ||
        e.title.toLowerCase().includes(q) ||
        e.body.toLowerCase().includes(q) ||
        e.tags.some((t) => t.includes(q)) ||
        (e.linkedJiraKey ?? "").toLowerCase().includes(q)
    );

  if (filtered.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground gap-3">
        <p className="text-sm">{search || activeTag ? "No entries match your filter." : emptyLabel}</p>
        {!search && !activeTag && (
          <Button size="sm" onClick={onNew}>
            <Plus className="h-4 w-4 mr-1" /> Add first entry
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {filtered.map((entry) => (
        <EntryCard
          key={entry.id}
          entry={entry}
          onEdit={() => onEdit(entry)}
          onDelete={() => onDelete(entry.id)}
          onCopy={() => onCopy(entry)}
          copied={copiedId === entry.id}
        />
      ))}
    </div>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export function KnowledgeBaseScreen({ onBack }: KnowledgeBaseScreenProps) {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("decision");

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<KnowledgeEntry | null>(null);

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [exportCopied, setExportCopied] = useState(false);

  // Load on mount
  useEffect(() => {
    loadKnowledgeEntries()
      .then(setEntries)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const saveEntry = useCallback(async (entry: KnowledgeEntry) => {
    await saveKnowledgeEntry(entry);
    setEntries((prev) => {
      const idx = prev.findIndex((e) => e.id === entry.id);
      const updated = idx >= 0 ? prev.map((e) => (e.id === entry.id ? entry : e)) : [entry, ...prev];
      return updated.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
  }, []);

  const deleteEntry = useCallback(async (id: string) => {
    await deleteKnowledgeEntry(id);
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }, []);

  function openNew() {
    setEditingEntry(null);
    setEditorOpen(true);
  }

  function openEdit(entry: KnowledgeEntry) {
    setEditingEntry(entry);
    setEditorOpen(true);
  }

  async function copyEntry(entry: KnowledgeEntry) {
    const md = `## ${entry.title}\n\n**Tags**: ${entry.tags.join(", ")}\n\n${entry.body}`;
    await navigator.clipboard.writeText(md);
    setCopiedId(entry.id);
    setTimeout(() => setCopiedId(null), 2000);
  }

  async function handleExport() {
    try {
      const md = await exportKnowledgeMarkdown();
      await navigator.clipboard.writeText(md);
      setExportCopied(true);
      setTimeout(() => setExportCopied(false), 2000);
    } catch (e) {
      console.error(e);
    }
  }

  // All unique tags across all entries for the filter row
  const allTags = [...new Set(entries.flatMap((e) => e.tags))].sort();

  const counts = {
    decision: entries.filter((e) => e.entryType === "decision").length,
    pattern: entries.filter((e) => e.entryType === "pattern").length,
    learning: entries.filter((e) => e.entryType === "learning").length,
  };

  return (
    <div className="min-h-screen">
      {/* Header */}
      <div className="border-b bg-background/95 backdrop-blur sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={onBack}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <h1 className="text-lg font-semibold leading-none">Knowledge Base</h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                {entries.length} {entries.length === 1 ? "entry" : "entries"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleExport} title="Copy all as markdown">
              {exportCopied ? (
                <Check className="h-4 w-4 mr-1.5 text-green-600" />
              ) : (
                <Download className="h-4 w-4 mr-1.5" />
              )}
              {exportCopied ? "Copied!" : "Export all"}
            </Button>
            <Button size="sm" onClick={openNew}>
              <Plus className="h-4 w-4 mr-1.5" /> New entry
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-6 space-y-5">
        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search entries…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Tag filter */}
        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setActiveTag(null)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                activeTag === null
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              All
            </button>
            {allTags.map((tag) => (
              <button
                key={tag}
                onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  activeTag === tag ? tagColour(tag) + " ring-2 ring-offset-1 ring-primary" : tagColour(tag) + " opacity-60 hover:opacity-100"
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Tabs */}
        {!loading && (
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="decision" className="gap-1.5">
                <BookOpen className="h-3.5 w-3.5" />
                Decision Log
                {counts.decision > 0 && (
                  <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-xs leading-none">
                    {counts.decision}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="pattern" className="gap-1.5">
                <Layers className="h-3.5 w-3.5" />
                Codebase Patterns
                {counts.pattern > 0 && (
                  <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-xs leading-none">
                    {counts.pattern}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="learning" className="gap-1.5">
                <Lightbulb className="h-3.5 w-3.5" />
                Retrospective Learnings
                {counts.learning > 0 && (
                  <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-xs leading-none">
                    {counts.learning}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="decision">
              <EntryList
                entries={entries}
                search={search}
                activeTag={activeTag}
                entryType="decision"
                onEdit={openEdit}
                onDelete={deleteEntry}
                copiedId={copiedId}
                onCopy={copyEntry}
                onNew={openNew}
                emptyLabel="No architectural decisions recorded yet. Add your first entry to start building your decision log."
              />
            </TabsContent>

            <TabsContent value="pattern">
              <EntryList
                entries={entries}
                search={search}
                activeTag={activeTag}
                entryType="pattern"
                onEdit={openEdit}
                onDelete={deleteEntry}
                copiedId={copiedId}
                onCopy={copyEntry}
                onNew={openNew}
                emptyLabel="No codebase patterns documented yet. Capture patterns to keep implementations consistent."
              />
            </TabsContent>

            <TabsContent value="learning">
              <EntryList
                entries={entries}
                search={search}
                activeTag={activeTag}
                entryType="learning"
                onEdit={openEdit}
                onDelete={deleteEntry}
                copiedId={copiedId}
                onCopy={copyEntry}
                onNew={openNew}
                emptyLabel="No retrospective learnings yet. Learnings from sprint retrospectives will appear here."
              />
            </TabsContent>
          </Tabs>
        )}

        {loading && (
          <div className="text-sm text-muted-foreground text-center py-12">Loading…</div>
        )}
      </div>

      {/* Entry editor */}
      <EntryEditor
        entry={editingEntry}
        defaultType={activeTab}
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        onSave={saveEntry}
      />
    </div>
  );
}
