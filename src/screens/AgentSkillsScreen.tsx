import { useState, useEffect } from "react";
import { ArrowLeft, Save, Trash2, BookOpen, Code2, Wrench, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  type SkillType,
  loadAgentSkills,
  saveAgentSkill,
  deleteAgentSkill,
} from "@/lib/tauri";

interface Props {
  onBack: () => void;
}

interface SkillDef {
  type: SkillType;
  label: string;
  icon: React.ReactNode;
  description: string;
  usedBy: string[];
  placeholder: string;
}

const SKILL_DEFS: SkillDef[] = [
  {
    type: "grooming",
    label: "Grooming Conventions",
    icon: <BookOpen className="h-4 w-4" />,
    description:
      "Guides the Grooming Agent in interpreting tickets. Encode team-specific conventions: which JIRA fields matter, how to read acceptance criteria, what constitutes an ambiguity, and what scope clues to look for.",
    usedBy: ["Grooming Agent"],
    placeholder: `Example:
- Our team writes acceptance criteria as "Given / When / Then" scenarios. Each scenario maps to a testable behaviour.
- Story points follow a Fibonacci scale. A 5-point ticket is a full sprint day for a senior engineer.
- Tickets tagged "infra" rarely touch business logic — focus grooming on deployment and configuration files.
- Labels starting with "SEC-" indicate a security-related change. Flag these as high-risk by default.
- If a ticket references another ticket without an explicit dependency link in JIRA, treat it as an ambiguity.`,
  },
  {
    type: "patterns",
    label: "Codebase Patterns",
    icon: <Code2 className="h-4 w-4" />,
    description:
      "Documents the architectural patterns and conventions used in the codebase. Used by the Impact Analysis Agent to understand how the code is structured, and by the Implementation Guidance Agent to suggest correct patterns.",
    usedBy: ["Impact Analysis Agent", "Implementation Guidance Agent"],
    placeholder: `Example:
- All Tauri commands are in src-tauri/src/commands/, one module per domain (jira.rs, bitbucket.rs, etc.)
- Frontend-to-backend communication is always via invoke() in src/lib/tauri.ts — never call fetch() directly.
- React state is local to screens — no global store. Shared state is lifted to the nearest common ancestor.
- All API types are defined in src/lib/tauri.ts alongside their command wrappers.
- shadcn/ui components are used for all UI — do not create raw HTML equivalents.
- Tailwind CSS only — no custom CSS files except for CSS variable overrides in index.css.`,
  },
  {
    type: "implementation",
    label: "Implementation Standards",
    icon: <Wrench className="h-4 w-4" />,
    description:
      "Coding style, naming conventions, and implementation dos and don'ts. Used by the Implementation Guidance Agent when producing step-by-step instructions for the engineer.",
    usedBy: ["Implementation Guidance Agent"],
    placeholder: `Example:
- TypeScript strict mode is enabled. No implicit any. All function return types must be explicit.
- Rust error handling: always return Result<T, String> from Tauri commands. Use map_err to convert errors to strings.
- React components use named exports, not default exports (except screen-level components).
- useEffect dependencies must be exhaustive — never suppress the eslint rule.
- Prefer early returns over nested conditionals in both TypeScript and Rust.
- Do not use console.log in production code — use a structured logger or remove debug output before committing.`,
  },
  {
    type: "review",
    label: "Review Standards",
    icon: <Eye className="h-4 w-4" />,
    description:
      "What good looks like for this codebase. Used by the Plan Review Agent to enforce team-specific review criteria beyond the generic checklist.",
    usedBy: ["Plan Review Agent"],
    placeholder: `Example:
- All new Tauri commands must be registered in both lib.rs and commands/mod.rs — a missing registration is a blocking finding.
- New API types on the frontend must have a corresponding TypeScript interface in tauri.ts.
- Any change to a Rust command signature must be matched with a corresponding update to the TypeScript wrapper.
- PRs that touch authentication or credential storage require a security-focused review pass.
- Test coverage is required for any new business logic. UI-only changes do not require tests.
- PR descriptions must reference the JIRA ticket key (e.g. PROJ-123) in the title or first line.`,
  },
];

export function AgentSkillsScreen({ onBack }: Props) {
  const [activeTab, setActiveTab] = useState<SkillType>("grooming");
  const [skills, setSkills] = useState<Partial<Record<SkillType, string>>>({});
  const [drafts, setDrafts] = useState<Partial<Record<SkillType, string>>>({});
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [savedAt, setSavedAt] = useState<Partial<Record<SkillType, string>>>({});

  useEffect(() => {
    loadAgentSkills()
      .then((loaded) => {
        setSkills(loaded);
        setDrafts(loaded);
      })
      .catch(console.error);
  }, []);

  const activeDef = SKILL_DEFS.find((d) => d.type === activeTab)!;
  const savedContent = skills[activeTab] ?? "";
  const draftContent = drafts[activeTab] ?? "";
  const isDirty = draftContent !== savedContent;
  const isEmpty = !savedContent;

  function handleDraftChange(value: string) {
    setDrafts((prev) => ({ ...prev, [activeTab]: value }));
  }

  async function handleSave() {
    setSaving(true);
    try {
      await saveAgentSkill(activeTab, draftContent);
      setSkills((prev) => ({ ...prev, [activeTab]: draftContent }));
      setSavedAt((prev) => ({
        ...prev,
        [activeTab]: new Date().toLocaleTimeString(),
      }));
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteAgentSkill(activeTab);
      setSkills((prev) => {
        const next = { ...prev };
        delete next[activeTab];
        return next;
      });
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[activeTab];
        return next;
      });
    } catch (e) {
      console.error(e);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b border-border px-6 py-4 flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-2">
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
        <div>
          <h1 className="text-lg font-semibold text-foreground">Agent Skills</h1>
          <p className="text-xs text-muted-foreground">
            Domain knowledge injected into AI agents to improve their understanding of your
            team and codebase
          </p>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar tabs */}
        <aside className="w-56 border-r border-border flex flex-col gap-1 p-3 shrink-0">
          {SKILL_DEFS.map((def) => {
            const hasContent = !!(skills[def.type] ?? "").trim();
            const isActive = activeTab === def.type;
            return (
              <button
                key={def.type}
                onClick={() => setActiveTab(def.type)}
                className={[
                  "flex items-center gap-3 px-3 py-2.5 rounded-md text-sm text-left transition-colors",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                ].join(" ")}
              >
                {def.icon}
                <span className="flex-1 leading-tight">{def.label}</span>
                {hasContent && (
                  <span
                    className={[
                      "w-2 h-2 rounded-full shrink-0",
                      isActive ? "bg-primary-foreground/60" : "bg-primary",
                    ].join(" ")}
                  />
                )}
              </button>
            );
          })}

          <div className="mt-auto pt-4 border-t border-border">
            <p className="text-xs text-muted-foreground px-3 leading-relaxed">
              Skills with a dot are active. Agents only receive a skill if content has been
              saved.
            </p>
          </div>
        </aside>

        {/* Editor panel */}
        <main className="flex-1 flex flex-col overflow-hidden">
          <div className="px-6 py-4 border-b border-border">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  {activeDef.icon}
                  <h2 className="font-semibold text-foreground">{activeDef.label}</h2>
                  {isEmpty ? (
                    <Badge variant="outline" className="text-xs text-muted-foreground">
                      Not set
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="text-xs">
                      Active
                    </Badge>
                  )}
                </div>
                <p className="text-sm text-muted-foreground max-w-2xl">
                  {activeDef.description}
                </p>
                <div className="flex items-center gap-1 mt-2">
                  <span className="text-xs text-muted-foreground">Used by:</span>
                  {activeDef.usedBy.map((agent) => (
                    <Badge key={agent} variant="outline" className="text-xs">
                      {agent}
                    </Badge>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {savedAt[activeTab] && !isDirty && (
                  <span className="text-xs text-muted-foreground">
                    Saved {savedAt[activeTab]}
                  </span>
                )}
                {!isEmpty && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleDelete}
                    disabled={deleting}
                    className="gap-2 text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Clear
                  </Button>
                )}
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={saving || !isDirty || !draftContent.trim()}
                  className="gap-2"
                >
                  <Save className="h-3.5 w-3.5" />
                  {saving ? "Saving…" : "Save"}
                </Button>
              </div>
            </div>
          </div>

          <div className="flex-1 p-6 overflow-auto">
            <Textarea
              value={draftContent}
              onChange={(e) => handleDraftChange(e.target.value)}
              placeholder={activeDef.placeholder}
              className="min-h-[500px] font-mono text-sm resize-none leading-relaxed"
            />
            {isDirty && (
              <p className="text-xs text-muted-foreground mt-2">
                Unsaved changes — click Save to persist
              </p>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
