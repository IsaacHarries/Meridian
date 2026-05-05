import type { ReactNode } from "react";
import { HeaderSettingsButton } from "@/components/HeaderSettingsButton";
import { HeaderRecordButton } from "@/components/HeaderRecordButton";
import { HeaderTasksButton } from "@/components/HeaderTasksButton";
import { HeaderTimeTracker } from "@/components/HeaderTimeTracker";
import { HeaderModelPicker } from "@/components/HeaderModelPicker";
import type { PanelId, StageId } from "@/stores/aiSelectionStore";
import { cn } from "@/lib/utils";

/** Matches the landing page header chrome (full-width bar). */
export const APP_HEADER_BAR =
  "sticky top-0 z-10 border-b bg-background/80 backdrop-blur-sm";

/** Single row: left cluster, spacer, right cluster + settings (panel screens). */
export const APP_HEADER_ROW_PANEL =
  "flex h-14 w-full items-center gap-2 overflow-hidden pl-2 pr-2.5 sm:pl-3 sm:pr-3";

/** Landing / onboarding: settings flush right. */
export const APP_HEADER_ROW_LANDING =
  "flex h-14 w-full items-center justify-end gap-2 overflow-hidden pl-2 pr-2.5 sm:pl-3 sm:pr-3";

/** Title next to back — same weight/size across panels. `min-w-0` is what
 *  lets `truncate` actually fire when the title sits as a flex child (the
 *  default `min-width: auto` would keep it at content width and prevent the
 *  ellipsis from triggering when the workspace narrows). */
export const APP_HEADER_TITLE =
  "min-w-0 text-sm font-semibold text-foreground truncate";

type WorkflowPanelHeaderProps = {
  leading: ReactNode;
  trailing?: ReactNode;
  /** Merged onto `<header>` (e.g. `z-20` over defaults). */
  barClassName?: string;
  /**
   * The AI panel context for the model picker. Omit on screens that do not
   * invoke any AI agent (e.g. the agent-skills browser).
   */
  panel?: PanelId;
  /** Implement-Ticket: the stage currently being viewed. */
  stage?: StageId | null;
};

/**
 * Back + title on the left, optional actions before the gear, settings flush right.
 * Same geometry as the landing header (padding, height, blur).
 */
export function WorkflowPanelHeader({
  leading,
  trailing,
  barClassName,
  panel,
  stage,
}: WorkflowPanelHeaderProps) {
  return (
    <header className={cn(APP_HEADER_BAR, barClassName)}>
      <div className={APP_HEADER_ROW_PANEL}>
        {/* Leading takes the available space (flex-1) so the title can truncate
            when the workspace narrows — the right-cluster icons (settings,
            tasks, model picker, etc.) stay shrink-0 and never get pushed off
            the row. Consumers MUST: (a) add `shrink-0` to the back button so
            it stays visible; (b) wrap multi-line titles in `min-w-0 flex-1`
            so they shrink with their parent. APP_HEADER_TITLE already carries
            `min-w-0 truncate`. */}
        <div className="relative z-10 flex min-w-0 flex-1 items-center gap-2">
          {leading}
        </div>
        <div className="relative z-10 flex shrink-0 items-center gap-2">
          {trailing}
          {panel ? <HeaderModelPicker panel={panel} stage={stage} /> : null}
          <HeaderTimeTracker />
          <HeaderRecordButton />
          <HeaderTasksButton />
          <HeaderSettingsButton className="shrink-0" />
        </div>
      </div>
    </header>
  );
}
