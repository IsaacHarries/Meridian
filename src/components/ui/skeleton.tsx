import { cn } from "@/lib/utils";

/**
 * Loading-state placeholder bar with a subtle pulse glow. Drop in for
 * any field that's about to be filled by streamed agent output so the
 * pipeline-stage panels render with their full structure on stage entry
 * instead of popping in element-by-element as data arrives.
 */
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-md bg-muted-foreground/15 animate-pulse",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Vertical stack of skeleton lines with slightly varying widths so the
 * placeholder reads as "a few sentences of text" rather than identical
 * bars. Use inside a list-style section that hasn't received content
 * yet.
 */
export function SkeletonLines({
  count = 3,
  className,
}: {
  count?: number;
  className?: string;
}) {
  // Deterministic pseudo-random widths so the skeleton doesn't reflow on
  // every render. Indexes map to one of three width buckets.
  const widths = ["95%", "82%", "68%"];
  return (
    <div className={cn("space-y-1.5", className)}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton
          key={i}
          className="h-3"
          style={{ width: widths[i % widths.length] }}
        />
      ))}
    </div>
  );
}
