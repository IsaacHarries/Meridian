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

export function priorityColor(p: string | null | undefined): string {
  switch (p?.toLowerCase()) {
    case "highest":
    case "critical":
      return "text-red-600 dark:text-red-400";
    case "high":
      return "text-orange-500 dark:text-orange-400";
    case "medium":
      return "text-yellow-500 dark:text-yellow-400";
    case "low":
      return "text-blue-500 dark:text-blue-400";
    case "lowest":
    case "trivial":
      return "text-muted-foreground";
    default:
      return "text-muted-foreground";
  }
}
