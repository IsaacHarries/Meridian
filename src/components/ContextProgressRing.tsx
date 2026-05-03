/**
 * Compact SVG progress ring that visualises how full the active
 * model's context window is. Used in the HeaderModelPicker trigger so
 * the user can see at a glance whether they're getting close to the
 * model's max-input cap.
 *
 * Stroke colour interpolates from grey (0% used) to white (100%) so
 * a glance at the ring tells the story without reading the number.
 * Sized to fit alongside the existing `in → out` token counter.
 */

interface ContextProgressRingProps {
  used: number;
  max: number;
  size?: number;
  strokeWidth?: number;
}

/**
 * Linearly interpolate between #888 (grey, ratio 0) and #fff (white,
 * ratio 1). Returns a `rgb(r, g, b)` colour string.
 */
function interpolateGreyToWhite(ratio: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  // Grey starts at #888 = 136. White is 255. Interpolate per channel
  // (R==G==B for both endpoints, so one calc suffices).
  const channel = Math.round(136 + (255 - 136) * clamped);
  return `rgb(${channel}, ${channel}, ${channel})`;
}

export function ContextProgressRing({
  used,
  max,
  size = 14,
  strokeWidth = 2,
}: ContextProgressRingProps) {
  const ratio = max > 0 ? used / max : 0;
  const clamped = Math.max(0, Math.min(1, ratio));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - clamped);
  const strokeColor = interpolateGreyToWhite(clamped);
  const pct = Math.round(clamped * 100);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`Context window: ${pct}% used (${used.toLocaleString()} of ${max.toLocaleString()} tokens)`}
    >
      <title>
        {`Context: ${pct}% — ${used.toLocaleString()} / ${max.toLocaleString()} tokens`}
      </title>
      {/* Background track — always grey at low alpha so the empty
          state is visibly an empty ring rather than nothing. */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="rgba(136, 136, 136, 0.25)"
        strokeWidth={strokeWidth}
      />
      {/* Progress arc — rotated −90° so 0% sits at the top and the
          arc fills clockwise, matching how progress rings are
          conventionally read. */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dashoffset 200ms ease, stroke 200ms ease" }}
      />
    </svg>
  );
}
