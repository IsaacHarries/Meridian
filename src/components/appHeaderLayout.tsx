import type { ReactNode } from "react";
import { HeaderSettingsButton } from "@/components/HeaderSettingsButton";
import { HeaderRecordButton } from "@/components/HeaderRecordButton";
import { HeaderTasksButton } from "@/components/HeaderTasksButton";
import { HeaderTimeTracker } from "@/components/HeaderTimeTracker";
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

/** Title next to back — same weight/size across panels. */
export const APP_HEADER_TITLE =
  "text-sm font-semibold text-foreground truncate";

type WorkflowPanelHeaderProps = {
  leading: ReactNode;
  trailing?: ReactNode;
  /** Merged onto `<header>` (e.g. `z-20` over defaults). */
  barClassName?: string;
};

/**
 * Back + title on the left, optional actions before the gear, settings flush right.
 * Same geometry as the landing header (padding, height, blur).
 */
export function WorkflowPanelHeader({
  leading,
  trailing,
  barClassName,
}: WorkflowPanelHeaderProps) {
  return (
    <header className={cn(APP_HEADER_BAR, barClassName)}>
      <div className={APP_HEADER_ROW_PANEL}>
        <div className="relative z-10 flex min-w-0 shrink-0 items-center gap-2">
          {leading}
        </div>
        <div className="min-w-0 flex-1" aria-hidden />
        <div className="relative z-10 flex shrink-0 items-center gap-2">
          {trailing}
          <HeaderTimeTracker />
          <HeaderRecordButton />
          <HeaderTasksButton />
          <HeaderSettingsButton className="shrink-0" />
        </div>
      </div>
    </header>
  );
}
