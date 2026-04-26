// Workflow icons drawn in the same line-art language as PipelineProgress —
// thin strokes, dots, arcs. All use currentColor so they inherit text colour
// from the surrounding card.
//
// Each icon is a 32x32 viewBox; size and stroke width can be overridden.

import type { ComponentProps } from "react";

type IconProps = ComponentProps<"svg"> & { strokeWidth?: number };

function IconBase({ children, strokeWidth = 1.4, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  );
}

// 1. Implement a Ticket — a ticket stub with perforated edge & a star above
export function ImplementTicketIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5 12 H27 V24 H5 Z" />
      <path d="M5 18 h2 m2 0 h2 m2 0 h2 m2 0 h2 m2 0 h2 m2 0 h2" />
      <circle cx="22" cy="8" r="1" fill="currentColor" />
      <circle cx="26" cy="6" r="0.7" fill="currentColor" />
      <path d="M22 8 L26 6" opacity="0.5" />
    </IconBase>
  );
}

// 2. Review a Pull Request — magnifier with concentric meridian arcs
export function ReviewPrIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="13" cy="13" r="7" />
      <circle cx="13" cy="13" r="3.5" opacity="0.6" />
      <circle cx="13" cy="13" r="1" fill="currentColor" />
      <path d="M19 19 L26 26" />
      <circle cx="26" cy="26" r="1" fill="currentColor" />
    </IconBase>
  );
}

// 3. Sprint Dashboard — three rising bars topped with dots (constellation)
export function SprintDashboardIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5 27 V20" />
      <path d="M12 27 V15" />
      <path d="M19 27 V11" />
      <path d="M26 27 V7" />
      <circle cx="5" cy="20" r="1.2" fill="currentColor" />
      <circle cx="12" cy="15" r="1.2" fill="currentColor" />
      <circle cx="19" cy="11" r="1.2" fill="currentColor" />
      <circle cx="26" cy="7" r="1.2" fill="currentColor" />
      <path d="M5 20 L12 15 L19 11 L26 7" opacity="0.45" strokeDasharray="1 1.5" />
    </IconBase>
  );
}

// 4. Sprint Retrospectives — orbit with a single highlighted node + trail
export function RetrospectivesIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="16" cy="16" r="9" opacity="0.35" />
      <circle cx="16" cy="7" r="1.6" fill="currentColor" />
      <circle cx="22.4" cy="9.6" r="0.7" fill="currentColor" opacity="0.7" />
      <circle cx="25" cy="16" r="0.5" fill="currentColor" opacity="0.45" />
      <path d="M9 9 A9 9 0 0 1 16 7" strokeWidth="1.6" />
    </IconBase>
  );
}

// 5. Groom Tickets / Quality — checklist with check + ambient dots
export function TicketQualityIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M7 9 H21" />
      <path d="M7 16 H21" />
      <path d="M7 23 H17" />
      <circle cx="24" cy="9" r="0.9" fill="currentColor" opacity="0.7" />
      <circle cx="24" cy="16" r="0.9" fill="currentColor" opacity="0.7" />
      <path d="M21 22 L24 25 L29 19" strokeWidth="1.7" />
    </IconBase>
  );
}

// 6. Knowledge Base — interconnected nodes (small star map)
export function KnowledgeBaseIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="8" cy="9" r="1.4" fill="currentColor" />
      <circle cx="22" cy="7" r="1.1" fill="currentColor" />
      <circle cx="16" cy="16" r="1.6" fill="currentColor" />
      <circle cx="7" cy="22" r="1.1" fill="currentColor" />
      <circle cx="24" cy="23" r="1.4" fill="currentColor" />
      <path d="M8 9 L16 16 L22 7" opacity="0.55" />
      <path d="M16 16 L7 22" opacity="0.55" />
      <path d="M16 16 L24 23" opacity="0.55" />
    </IconBase>
  );
}

// 7. Address PR Comments — speech bubble with three dots
export function AddressCommentsIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M6 9 H26 a2 2 0 0 1 2 2 v8 a2 2 0 0 1 -2 2 H14 L9 26 V21 H6 a2 2 0 0 1 -2 -2 V11 a2 2 0 0 1 2 -2 Z" />
      <circle cx="11" cy="15" r="0.9" fill="currentColor" />
      <circle cx="16" cy="15" r="0.9" fill="currentColor" />
      <circle cx="21" cy="15" r="0.9" fill="currentColor" />
    </IconBase>
  );
}

// 8. Meetings — audio waveform (variable-height vertical strokes)
export function MeetingsIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 16 V16" />
      <path d="M7 12 V20" />
      <path d="M10 9 V23" />
      <path d="M13 14 V18" />
      <path d="M16 7 V25" />
      <path d="M19 11 V21" />
      <path d="M22 14 V18" />
      <path d="M25 10 V22" />
      <path d="M28 13 V19" />
    </IconBase>
  );
}

// ── Map from WorkflowId → Icon component ───────────────────────────────────────

import type { WorkflowId } from "@/screens/WorkflowScreen";

export const WORKFLOW_ICONS: Record<WorkflowId, React.FC<IconProps>> = {
  "implement-ticket":     ImplementTicketIcon,
  "review-pr":            ReviewPrIcon,
  "sprint-dashboard":     SprintDashboardIcon,
  "retrospectives":       RetrospectivesIcon,
  "ticket-quality":       TicketQualityIcon,
  "knowledge-base":       KnowledgeBaseIcon,
  "address-pr-comments":  AddressCommentsIcon,
  "meetings":             MeetingsIcon,
};
