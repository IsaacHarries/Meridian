const PRIORITY_ORDER: Record<string, number> = {
  highest: 0,
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  lowest: 4,
  trivial: 4,
};

export function priorityRank(p: string | null | undefined): number {
  return p != null ? (PRIORITY_ORDER[p.toLowerCase()] ?? 2) : 99;
}

const PRIORITY_COLOR: Record<string, string> = {
  highest: "text-red-600 dark:text-red-400",
  critical: "text-red-600 dark:text-red-400",
  high: "text-orange-500 dark:text-orange-400",
  medium: "text-yellow-500 dark:text-yellow-400",
  low: "text-blue-500 dark:text-blue-400",
  lowest: "text-muted-foreground",
  trivial: "text-muted-foreground",
};

export function priorityColor(p: string | null | undefined): string {
  return PRIORITY_COLOR[p?.toLowerCase() ?? ""] ?? "text-muted-foreground";
}
