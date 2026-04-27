// Workflow icons drawn in the same line-art language as PipelineProgress —
// thin strokes, dots, arcs. All use currentColor so they inherit text colour
// from the surrounding card.
//
// Each icon is a 32x32 viewBox; size and stroke width can be overridden.

import type { ComponentProps } from "react";

type IconProps = ComponentProps<"svg"> & { strokeWidth?: number };

function IconBase({
  children,
  strokeWidth = 1.4,
  ...rest
}: IconProps & { children: React.ReactNode }) {
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

// 1. Implement a Ticket — a ticket nested between code braces. The braces
// signal "this becomes code"; the perforated stub keeps it readable as a
// ticket. Conveys the workflow's whole arc (JIRA ticket → delivered PR).
export function ImplementTicketIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      {/* Left curly brace { */}
      <path d="M8 4 Q5 4 5 7 V14 Q5 16 3 16 Q5 16 5 18 V25 Q5 28 8 28" />
      {/* Right curly brace } */}
      <path d="M24 4 Q27 4 27 7 V14 Q27 16 29 16 Q27 16 27 18 V25 Q27 28 24 28" />
      {/* Ticket nested between the braces — diagonal stub silhouette
          rendered as a fill so it reads as solid against the stroked braces. */}
      <svg
        x="8"
        y="8"
        width="16"
        height="16"
        viewBox="0 0 512 512"
        fill="currentColor"
      >
        <path
          d="m451.4 145.4-5.6-5.6c-5.6 5.6-10.2 8.3-14.8 10.2-4.6 2.8-10.2 3.7-18.5 3.7-15.7 0-29.6-5.6-39.8-15.7-9.3-9.3-15.7-23.1-15.7-39.8 0-8.3.9-13.9 2.8-19.4 1.9-4.6 4.6-9.3 10.2-14.8l5.6-5.6L317.1 0 .5 318.5l58.3 58.3 5.6-5.6c5.6-5.6 10.2-8.3 14.8-10.2s10.2-2.8 19.4-2.8c15.7 0 29.6 5.6 39.8 15.7 9.3 9.3 15.7 23.1 15.7 39.8 0 8.3-.9 13.9-2.8 19.4-1.9 4.6-4.6 9.3-10.2 14.8l-5.6 5.6L194 512l317.6-317.6-58.3-58.3-5.6 5.6zl-5.6 5.6 41.7 41.7-295.4 295.2-41.7-41.7-5.6 5.6 5.6 5.6c6.5-6.5 11.1-13 13.9-20.4s3.7-15.7 3.7-25c0-20.4-7.4-38-20.4-50.9s-30.6-20.4-50.9-20.4c-9.3 0-17.6.9-25 3.7s-13.9 7.4-20.4 13.9l5.6 5.6 5.6-5.6-41.7-41.7L316.2 21.3 357.8 63l5.6-5.6-5.6-5.6c-6.5 6.5-11.1 13-13.9 20.4s-3.7 15.7-3.7 25c0 20.4 7.4 38 20.4 50.9 13 13 30.6 20.4 50.9 20.4 9.3 0 17.6-.9 25-3.7s13.9-7.4 20.4-13.9zl-5.6 5.6z"
          stroke="currentColor"
          strokeWidth="16"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
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

// 3. Sprint Dashboard — fill-based dashboard report silhouette: monitor
// frame containing a bar chart and two list rows, with a pie chart on the
// left. Departs from the line-art language because the source artwork is a
// single fill path; uses currentColor so it still inherits text colour.
export function SprintDashboardIcon({ strokeWidth: _strokeWidth, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 122.9 85.6"
      fill="currentColor"
      stroke="none"
      fillRule="evenodd"
      clipRule="evenodd"
      {...rest}
    >
      <path d="M7.5,0h107.9c4.1,0,7.5,3.4,7.5,7.5v70.6c0,4.1-3.4,7.5-7.5,7.5H7.5c-4.1,0-7.5-3.4-7.5-7.5V7.5C0,3.4,3.4,0,7.5,0L7.5,0z M69.9,63.3h28.5v4H69.9V63.3L69.9,63.3z M69.9,53.1H109v4H69.9V53.1L69.9,53.1z M92.1,35h5.6c0.3,0,0.5,0.2,0.5,0.5v11c0,0.3-0.2,0.5-0.5,0.5h-5.6c-0.3,0-0.5-0.2-0.5-0.5v-11C91.6,35.3,91.8,35,92.1,35L92.1,35L92.1,35z M70.5,28.3h5.6c0.3,0,0.5,0.2,0.5,0.5v17.8c0,0.3-0.2,0.5-0.5,0.5h-5.6c-0.3,0-0.5-0.2-0.5-0.5V28.8C69.9,28.5,70.2,28.3,70.5,28.3L70.5,28.3L70.5,28.3L70.5,28.3z M81.3,24.5h5.6c0.3,0,0.5,0.2,0.5,0.5v21.6c0,0.3-0.2,0.5-0.5,0.5h-5.6c-0.3,0-0.5-0.2-0.5-0.5V25C80.8,24.7,81,24.5,81.3,24.5L81.3,24.5L81.3,24.5z M39.3,48.2l17,0.3c0,6.1-3,11.7-8,15.1L39.3,48.2L39.3,48.2L39.3,48.2z M37.6,45.3l-0.2-19.8l0-1.3l1.3,0.1h0h0c1.6,0.1,3.2,0.4,4.7,0.8c1.5,0.4,2.9,1,4.3,1.7c6.9,3.6,11.7,10.8,12.1,19l0.1,1.3l-1.3,0l-19.7-0.6l-1.1,0L37.6,45.3L37.6,45.3L37.6,45.3z M39.8,26.7L40,44.1l17.3,0.5c-0.7-6.8-4.9-12.7-10.7-15.8c-1.2-0.6-2.5-1.1-3.8-1.5C41.7,27.1,40.8,26.9,39.8,26.7L39.8,26.7L39.8,26.7z M35.9,47.2L45.6,64c-3,1.7-6.3,2.6-9.7,2.6c-10.7,0-19.4-8.7-19.4-19.4c0-10.4,8.2-19,18.6-19.4L35.9,47.2L35.9,47.2L35.9,47.2z M115.6,14.1H7.2v64.4h108.4V14.1L115.6,14.1L115.6,14.1z" />
    </svg>
  );
}

// 4. Sprint Retrospectives — telescope pointed at the Big Dipper (looking back)
export function RetrospectivesIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      {/* Big Dipper — handle (3 stars curving) + bowl (4-star parallelogram).
          Stars spread further apart for legibility. */}
      <path d="M3 4 L9 3 L15 5 L21 7 L22 13 L30 13 L29 7 L21 7" opacity="0.5" />
      <circle cx="3" cy="4" r="1.3" fill="currentColor" />
      <circle cx="9" cy="3" r="1.1" fill="currentColor" />
      <circle cx="15" cy="5" r="1.1" fill="currentColor" />
      <circle cx="21" cy="7" r="1.4" fill="currentColor" />
      <circle cx="22" cy="13" r="1.2" fill="currentColor" />
      <circle cx="30" cy="13" r="1.2" fill="currentColor" />
      <circle cx="29" cy="7" r="1.2" fill="currentColor" />

      {/* Tripod legs */}
      <path d="M9 24 L5 30 M9 24 L13 30" />
      {/* Telescope tube — bigger, aimed upper-right toward the constellation */}
      <g transform="rotate(-32 9 24)">
        <rect x="1.5" y="22" width="16" height="4" rx="1" />
      </g>
    </IconBase>
  );
}

// 5. Groom Tickets — diagonal comb silhouette (filled). Departs from the
// other line-art icons because the source artwork is a single fill path; uses
// currentColor so it still inherits text colour from the surrounding card.
export function TicketQualityIcon({
  strokeWidth: _strokeWidth,
  ...rest
}: IconProps) {
  return (
    <svg
      viewBox="0 0 512 512"
      fill="currentColor"
      stroke="none"
      fillRule="evenodd"
      clipRule="evenodd"
      {...rest}
    >
      <path d="M8.67 148.09c-4.95 3.02-9.47-2.72-8.55-6.42C22.44 85.3 69.22 20.18 122.27 3.58c20.46-6.4 18.86-4.71 32.63 9.07l167.22 167.21 10.02 10.02L499.35 357.1c13.78 13.77 15.47 12.17 9.07 32.63-16.6 53.05-81.72 99.83-138.09 122.15-3.7.92-9.44-3.6-6.42-8.55l88.39-88.39-8.69-8.69-86.85 86.85c-2.77 2.76-7.29 2.72-10.1-.1-2.82-2.82-2.87-7.34-.11-10.1l86.85-86.85-11.5-11.5-86.85 86.84c-2.76 2.76-7.28 2.72-10.1-.1-2.82-2.81-2.86-7.34-.1-10.1l86.85-86.85-9.86-9.85-86.85 86.85c-2.76 2.76-7.28 2.71-10.1-.1-2.81-2.82-2.86-7.34-.1-10.1l86.85-86.85-9.85-9.85-86.85 86.85c-2.76 2.76-7.28 2.71-10.1-.11-2.82-2.81-2.86-7.34-.1-10.1l86.85-86.85-9.85-9.85-86.86 86.85c-2.76 2.76-7.28 2.71-10.09-.1-2.82-2.82-2.87-7.34-.11-10.1l86.85-86.85-9.85-9.85-86.85 86.85c-2.76 2.76-7.28 2.71-10.1-.11-2.82-2.81-2.86-7.34-.1-10.1l86.85-86.85-9.86-9.85-86.84 86.85c-2.77 2.76-7.29 2.71-10.1-.1-2.82-2.82-2.87-7.34-.11-10.1l86.85-86.85-9.85-9.85-86.85 86.85c-2.76 2.76-7.28 2.71-10.1-.11-2.82-2.81-2.86-7.34-.1-10.1l86.85-86.85-11.68-11.67-86.85 86.85c-2.76 2.76-7.28 2.71-10.1-.11-2.81-2.81-2.86-7.33-.1-10.09l86.85-86.85-11.5-11.51-86.85 86.85c-2.76 2.76-7.29 2.72-10.1-.1-2.82-2.82-2.87-7.34-.11-10.1l86.85-86.85-9.85-9.85-86.85 86.85c-2.76 2.76-7.28 2.71-10.1-.11-2.81-2.81-2.86-7.34-.1-10.1l86.85-86.84-9.85-9.86-86.85 86.85c-2.76 2.76-7.29 2.72-10.1-.1-2.82-2.82-2.87-7.34-.11-10.1l86.85-86.85-9.85-9.85-86.85 86.85c-2.76 2.76-7.28 2.71-10.1-.11-2.81-2.81-2.86-7.33-.1-10.09l86.85-86.86-9.85-9.85-86.85 86.85c-2.76 2.76-7.29 2.72-10.1-.1-2.82-2.82-2.87-7.34-.11-10.1l86.85-86.85-9.85-9.85-86.85 86.85c-2.76 2.76-7.28 2.71-10.1-.1-2.81-2.82-2.86-7.34-.1-10.1l86.85-86.85-9.85-9.86-86.85 86.85c-2.76 2.76-7.29 2.72-10.1-.1-2.82-2.82-2.86-7.34-.1-10.1l86.84-86.85-11.5-11.5-86.85 86.85c-2.76 2.76-7.28 2.71-10.1-.11-2.82-2.81-2.86-7.34-.1-10.1l86.85-86.85-8.69-8.69-88.39 88.39z" />
    </svg>
  );
}

// 6. Address PR Comments — speech bubble with three dots
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

// 7. Meetings — audio waveform (variable-height vertical strokes)
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
  "implement-ticket": ImplementTicketIcon,
  "review-pr": ReviewPrIcon,
  "sprint-dashboard": SprintDashboardIcon,
  retrospectives: RetrospectivesIcon,
  "ticket-quality": TicketQualityIcon,
  "address-pr-comments": AddressCommentsIcon,
  meetings: MeetingsIcon,
};
