import { HeaderRecordButton } from "@/components/HeaderRecordButton";
import { HeaderSettingsButton } from "@/components/HeaderSettingsButton";
import { HeaderTimeTracker } from "@/components/HeaderTimeTracker";
import {
    APP_HEADER_BAR,
    APP_HEADER_ROW_PANEL,
    APP_HEADER_TITLE,
} from "@/components/appHeaderLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { type CredentialStatus, anthropicComplete, bitbucketComplete, bitbucketCredentialsSet, getCredentialStatus, jiraComplete, jiraCredentialsSet } from "@/lib/tauri/credentials";
import { cn } from "@/lib/utils";
import {
    Activity,
    Bell,
    Bot,
    ChevronRight,
    Clock,
    FileText,
    FlaskConical,
    HardDrive,
    Link2,
    ListTodo,
    Loader2,
    NotebookPen,
    Palette,
    Sparkles,
    X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AiDebugSection } from "./settings/ai-debug";
import {
    DefaultModelCard,
    MaxOutputTokensSection,
    PerPanelAiSection,
} from "./settings/ai-defaults";
import { AnthropicSection } from "./settings/anthropic";
import { BitbucketSection } from "./settings/bitbucket";
import { CacheSection } from "./settings/cache";
import { ConfigSection } from "./settings/config";
import { CopilotSection } from "./settings/copilot";
import { CrossMeetingsSearchSection } from "./settings/cross-meetings";
import { DataDirectorySection } from "./settings/data-directory";
import { DataTestSection } from "./settings/data-test";
import { GeminiSection } from "./settings/gemini";
import { GroomingTemplatesSection } from "./settings/grooming-templates";
import { JiraSection } from "./settings/jira";
import { LocalLlmSection } from "./settings/local-llm";
import { MeetingsSection } from "./settings/meetings";
import { MockClaudeModeSection, MockModeSection } from "./settings/mock-mode";
import { NoteTemplatesSection } from "./settings/note-templates";
import { NotificationsSettingsSection } from "./settings/notifications";
import { OnboardingPreviewSection } from "./settings/onboarding-preview";
import {
    PipelineSettingsSection,
    PrReviewSettingsSection,
    PrTasksPollIntervalSection,
    SprintDashboardSettingsSection,
} from "./settings/pipeline";
import { PrTaskFiltersSection } from "./settings/pr-task-filters";
import { PrTemplateSection } from "./settings/pr-template";
import { ThemeSection } from "./settings/theme";
import { TimeTrackingSection } from "./settings/time-tracking";

interface SettingsScreenProps {
  onClose: () => void;
  onNavigate?: (screen: string) => void;
}

export function SettingsScreen({ onClose, onNavigate }: SettingsScreenProps) {
  const [credStatus, setCredStatus] = useState<CredentialStatus | null>(null);
  const [activeCategory, setActiveCategory] = useState("ai");
  const scrollRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  // Suppress scroll-spy briefly after a click-to-scroll so the click target wins
  const suppressSpyUntil = useRef(0);

  async function refresh() {
    const s = await getCredentialStatus();
    setCredStatus(s);
  }

  function handleMockToggle() {
    refresh();
  }

  useEffect(() => {
    refresh();
  }, []);

  const fullyConfigured = credStatus
    ? anthropicComplete(credStatus) &&
      jiraComplete(credStatus) &&
      bitbucketComplete(credStatus)
    : false;

  type NavItem = { id: string; label: string; icon: React.ElementType };
  const navItems: NavItem[] = [
    { id: "ai", label: "AI", icon: Sparkles },
    ...(onNavigate
      ? [{ id: "agents", label: "Agents", icon: Bot } as NavItem]
      : []),
    { id: "integrations", label: "Integrations", icon: Link2 },
    { id: "tasks", label: "Tasks", icon: ListTodo },
    { id: "pipeline", label: "Workflows", icon: Activity },
    { id: "notifications", label: "Notifications", icon: Bell },
    { id: "appearance", label: "Appearance", icon: Palette },
    { id: "storage", label: "Storage", icon: HardDrive },
    { id: "time-tracking", label: "Time", icon: Clock },
    { id: "meetings", label: "Meetings", icon: NotebookPen },
    { id: "templates", label: "Templates", icon: FileText },
    { id: "development", label: "Development", icon: FlaskConical },
  ];

  // Scroll-spy: update active nav item as user scrolls
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    function onScroll() {
      if (Date.now() < suppressSpyUntil.current) return;
      const containerRect = container!.getBoundingClientRect();
      const threshold = containerRect.top + 80; // 80px from top of scroll area
      let current = navItems[0].id;
      for (const { id } of navItems) {
        const el = sectionRefs.current[id];
        if (!el) continue;
        if (el.getBoundingClientRect().top <= threshold) current = id;
      }
      setActiveCategory(current);
    }

    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
    // navItems is derived from props/state that don't change after mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function scrollToSection(id: string) {
    const el = sectionRefs.current[id];
    if (!el || !scrollRef.current) return;
    setActiveCategory(id);
    suppressSpyUntil.current = Date.now() + 800;
    el.scrollIntoView({ behavior: "smooth" });
  }

  function sectionRef(id: string) {
    return (el: HTMLElement | null) => {
      sectionRefs.current[id] = el;
    };
  }

  return (
    <div className="h-screen flex flex-col">
      <header className={APP_HEADER_BAR}>
        <div className={APP_HEADER_ROW_PANEL}>
          <h1 className={cn(APP_HEADER_TITLE, "shrink-0")}>Settings</h1>
          <div className="min-w-0 flex-1" aria-hidden />
          <div className="flex shrink-0 items-center gap-1">
            <HeaderTimeTracker />
            <HeaderRecordButton />
            <HeaderSettingsButton />
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label="Close settings"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <nav className="w-44 shrink-0 border-r flex flex-col gap-0.5 p-3 overflow-y-auto">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => scrollToSection(id)}
              className={cn(
                "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors text-left w-full",
                activeCategory === id
                  ? "bg-background text-foreground shadow-sm font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-background/60",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </button>
          ))}
        </nav>

        {/* Scrollable content */}
        <main ref={scrollRef} className="flex-1 overflow-y-auto">
          {!credStatus ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="max-w-3xl mx-auto px-10 py-8 space-y-8">
              <section ref={sectionRef("ai")} className="space-y-4 pt-2">
                <h2 className="text-xl font-semibold text-foreground">AI</h2>
                <AnthropicSection
                  isConfigured={anthropicComplete(credStatus)}
                  onSaved={refresh}
                />
                <GeminiSection
                  isConfigured={credStatus.geminiApiKey}
                  onSaved={refresh}
                />
                <CopilotSection
                  isConfigured={credStatus.copilotApiKey}
                  onSaved={refresh}
                />
                <LocalLlmSection
                  isConfigured={credStatus.localLlmUrl}
                  onSaved={refresh}
                />
                <DefaultModelCard />
                <PerPanelAiSection />
                <MaxOutputTokensSection />
                <p className="text-xs text-muted-foreground pt-1">
                  All credentials are stored in your macOS Keychain and never
                  leave your machine. They are used exclusively in the Tauri
                  backend layer and never exposed to the UI.
                </p>
              </section>

              {onNavigate && (
                <section
                  ref={sectionRef("agents")}
                  className="space-y-4 border-t pt-8"
                >
                  <h2 className="text-xl font-semibold text-foreground">
                    Agents
                  </h2>
                  <Card
                    className="cursor-pointer hover:bg-muted/40 transition-colors"
                    onClick={() => onNavigate("agent-skills")}
                  >
                    <CardContent className="flex items-center gap-4 py-4">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
                        <Sparkles className="h-4 w-4 text-primary" />
                      </div>
                      <div className="flex-1">
                        <p className="text-sm font-medium">Agent Skills</p>
                        <p className="text-xs text-muted-foreground">
                          Configure domain knowledge injected into AI agents —
                          grooming conventions, codebase patterns,
                          implementation standards, review criteria
                        </p>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </CardContent>
                  </Card>
                </section>
              )}

              <section
                ref={sectionRef("integrations")}
                className="space-y-4 border-t pt-8"
              >
                <h2 className="text-xl font-semibold text-foreground">
                  Integrations
                </h2>
                <JiraSection
                  isConfigured={jiraCredentialsSet(credStatus)}
                  onSaved={refresh}
                />
                <BitbucketSection
                  isConfigured={bitbucketCredentialsSet(credStatus)}
                  onSaved={refresh}
                />
                <ConfigSection
                  jiraBoardId={credStatus.jiraBoardId}
                  bitbucketRepoSlug={credStatus.bitbucketRepoSlug}
                  onSaved={refresh}
                />
                <DataTestSection fullyConfigured={fullyConfigured} />
              </section>

              <section
                ref={sectionRef("tasks")}
                className="space-y-4 border-t pt-8"
              >
                <h2 className="text-xl font-semibold text-foreground">Tasks</h2>
                <PrTasksPollIntervalSection />
                <PrTaskFiltersSection />
              </section>

              <section
                ref={sectionRef("pipeline")}
                className="space-y-4 border-t pt-8"
              >
                <h2 className="text-xl font-semibold text-foreground">
                  Workflows
                </h2>
                <PipelineSettingsSection />
                <PrReviewSettingsSection />
                <SprintDashboardSettingsSection />
              </section>

              <section
                ref={sectionRef("notifications")}
                className="space-y-4 border-t pt-8"
              >
                <h2 className="text-xl font-semibold text-foreground">
                  Notifications
                </h2>
                <NotificationsSettingsSection />
              </section>

              <section
                ref={sectionRef("appearance")}
                className="space-y-4 border-t pt-8"
              >
                <h2 className="text-xl font-semibold text-foreground">
                  Appearance
                </h2>
                <ThemeSection />
              </section>

              <section
                ref={sectionRef("storage")}
                className="space-y-4 border-t pt-8"
              >
                <h2 className="text-xl font-semibold text-foreground">
                  Storage
                </h2>
                <DataDirectorySection />
                <CacheSection />
              </section>

              <section
                ref={sectionRef("time-tracking")}
                className="space-y-4 border-t pt-8"
              >
                <h2 className="text-xl font-semibold text-foreground">
                  Time Tracking
                </h2>
                <TimeTrackingSection />
              </section>

              <section
                ref={sectionRef("meetings")}
                className="space-y-4 border-t pt-8"
              >
                <h2 className="text-xl font-semibold text-foreground">
                  Meetings
                </h2>
                <MeetingsSection />
                <CrossMeetingsSearchSection />
                <NoteTemplatesSection />
              </section>

              <section
                ref={sectionRef("templates")}
                className="space-y-4 border-t pt-8"
              >
                <h2 className="text-xl font-semibold text-foreground">
                  Templates
                </h2>
                <PrTemplateSection />
                <GroomingTemplatesSection />
              </section>

              <section
                ref={sectionRef("development")}
                className="space-y-4 border-t pt-8"
              >
                <h2 className="text-xl font-semibold text-foreground">
                  Development
                </h2>
                <OnboardingPreviewSection />
                <AiDebugSection />
                <MockModeSection onToggle={handleMockToggle} />
                <MockClaudeModeSection onToggle={handleMockToggle} />
              </section>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
