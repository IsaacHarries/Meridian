import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type SprintStats } from "@/lib/tauri/trends";
import {
    Bar,
    BarChart,
    CartesianGrid,
    ComposedChart,
    Legend,
    Line,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";

// Shared chart styling. Colours map to tailwind semantic palette.
const COLOR_COMMITTED = "#6b7280"; // gray-500
const COLOR_COMPLETED = "#10b981"; // emerald-500
const COLOR_CARRYOVER = "#ef4444"; // red-500
const COLOR_DONE = "#10b981";
const COLOR_BUGS = "#ef4444";
const COLOR_STORIES = "#3b82f6"; // blue-500
const COLOR_TASKS = "#a855f7"; // purple-500
const COLOR_OTHER = "#9ca3af"; // gray-400
const COLOR_PRS = "#3b82f6";
const COLOR_CYCLE = "#f59e0b"; // amber-500
const COLOR_LINE_ACCENT = "#8b5cf6"; // violet-500

// Short sprint label (strip leading "Sprint ") to keep X-axis compact.
function shortName(name: string): string {
  return name.replace(/^sprint\s*/i, "S");
}

// Recharts renders tooltips as plain HTML — style to match our dark/light theme.
const tooltipStyle = {
  backgroundColor: "hsl(var(--popover))",
  border: "1px solid hsl(var(--border))",
  borderRadius: "6px",
  color: "hsl(var(--popover-foreground))",
  fontSize: "12px",
};

const axisTick = { fontSize: 11, fill: "hsl(var(--muted-foreground))" };

interface Props {
  stats: SprintStats[];
}

// ── 1. Velocity — committed vs completed points + completion % overlay ───────

function VelocityChart({ stats }: Props) {
  const data = stats.map((s) => ({
    name: shortName(s.name),
    fullName: s.name,
    committed: Number(s.committedPoints.toFixed(1)),
    completed: Number(s.completedPoints.toFixed(1)),
    completionPct: Number(s.velocityPct.toFixed(0)),
  }));

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Velocity — committed vs completed points</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="name" tick={axisTick} />
            <YAxis yAxisId="left" tick={axisTick} label={{ value: "pts", angle: -90, position: "insideLeft", offset: 20, style: { fontSize: 10, fill: "hsl(var(--muted-foreground))" } }} />
            <YAxis
              yAxisId="right"
              orientation="right"
              tick={axisTick}
              domain={[0, 100]}
              label={{ value: "%", angle: 90, position: "insideRight", offset: 10, style: { fontSize: 10, fill: "hsl(var(--muted-foreground))" } }}
            />
            <Tooltip contentStyle={tooltipStyle} labelFormatter={(_, p) => p[0]?.payload.fullName ?? ""} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar yAxisId="left" dataKey="committed" fill={COLOR_COMMITTED} name="Committed pts" />
            <Bar yAxisId="left" dataKey="completed" fill={COLOR_COMPLETED} name="Completed pts" />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="completionPct"
              stroke={COLOR_LINE_ACCENT}
              strokeWidth={2}
              dot={{ r: 3 }}
              name="Velocity %"
            />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

// ── 2. Issue flow — done vs carry-over (stacked bar) ─────────────────────────

function IssueFlowChart({ stats }: Props) {
  const data = stats.map((s) => ({
    name: shortName(s.name),
    fullName: s.name,
    done: s.completedIssues,
    carryover: s.carryoverCount,
  }));

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Issue flow — done vs carry-over</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="name" tick={axisTick} />
            <YAxis tick={axisTick} allowDecimals={false} />
            <Tooltip contentStyle={tooltipStyle} labelFormatter={(_, p) => p[0]?.payload.fullName ?? ""} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="done" stackId="a" fill={COLOR_DONE} name="Done" />
            <Bar dataKey="carryover" stackId="a" fill={COLOR_CARRYOVER} name="Carry-over" />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

// ── 3. PR throughput + avg cycle time (dual-axis combo) ──────────────────────

function PrThroughputChart({ stats }: Props) {
  const hasAny = stats.some((s) => s.prsTotal > 0);
  const data = stats.map((s) => ({
    name: shortName(s.name),
    fullName: s.name,
    merged: s.prsMerged,
    total: s.prsTotal,
    avgCycle: s.avgCycleHours != null ? Number(s.avgCycleHours.toFixed(1)) : null,
  }));

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          PR throughput &amp; avg cycle time
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!hasAny ? (
          <p className="text-xs text-muted-foreground py-8 text-center">
            No PR data recorded for any of the selected sprints.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="name" tick={axisTick} />
              <YAxis yAxisId="left" tick={axisTick} allowDecimals={false} label={{ value: "PRs", angle: -90, position: "insideLeft", offset: 20, style: { fontSize: 10, fill: "hsl(var(--muted-foreground))" } }} />
              <YAxis yAxisId="right" orientation="right" tick={axisTick} label={{ value: "hrs", angle: 90, position: "insideRight", offset: 10, style: { fontSize: 10, fill: "hsl(var(--muted-foreground))" } }} />
              <Tooltip contentStyle={tooltipStyle} labelFormatter={(_, p) => p[0]?.payload.fullName ?? ""} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar yAxisId="left" dataKey="merged" fill={COLOR_PRS} name="Merged PRs" />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="avgCycle"
                stroke={COLOR_CYCLE}
                strokeWidth={2}
                dot={{ r: 3 }}
                name="Avg cycle (hrs)"
                connectNulls
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

// ── 4. Issue type mix (stacked bar) ──────────────────────────────────────────

function IssueTypeChart({ stats }: Props) {
  const data = stats.map((s) => ({
    name: shortName(s.name),
    fullName: s.name,
    bugs: s.bugCount,
    stories: s.storyCount,
    tasks: s.taskCount,
    other: s.otherIssueCount,
  }));

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Issue type mix</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="name" tick={axisTick} />
            <YAxis tick={axisTick} allowDecimals={false} />
            <Tooltip contentStyle={tooltipStyle} labelFormatter={(_, p) => p[0]?.payload.fullName ?? ""} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="stories" stackId="b" fill={COLOR_STORIES} name="Stories" />
            <Bar dataKey="tasks" stackId="b" fill={COLOR_TASKS} name="Tasks" />
            <Bar dataKey="bugs" stackId="b" fill={COLOR_BUGS} name="Bugs" />
            <Bar dataKey="other" stackId="b" fill={COLOR_OTHER} name="Other" />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

// ── 5. Per-assignee workload across selected sprints (horizontal bar) ────────

function AssigneeWorkloadChart({ stats }: Props) {
  // Aggregate across all sprints in the window.
  const totals = new Map<string, { assigned: number; completed: number }>();
  for (const s of stats) {
    for (const a of s.assigneeAssignedPoints) {
      const entry = totals.get(a.name) ?? { assigned: 0, completed: 0 };
      entry.assigned += a.points;
      totals.set(a.name, entry);
    }
    for (const a of s.assigneeCompletedPoints) {
      const entry = totals.get(a.name) ?? { assigned: 0, completed: 0 };
      entry.completed += a.points;
      totals.set(a.name, entry);
    }
  }
  const data = Array.from(totals.entries())
    .map(([name, { assigned, completed }]) => ({
      name,
      assigned: Number(assigned.toFixed(1)),
      completed: Number(completed.toFixed(1)),
      notDone: Number(Math.max(0, assigned - completed).toFixed(1)),
    }))
    .sort((a, b) => b.assigned - a.assigned);

  const height = Math.max(160, data.length * 34);

  if (data.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          Per-assignee workload across selected sprints (points)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={height}>
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 4, right: 16, bottom: 0, left: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
            <XAxis type="number" tick={axisTick} />
            <YAxis
              type="category"
              dataKey="name"
              tick={axisTick}
              width={110}
              interval={0}
            />
            <Tooltip contentStyle={tooltipStyle} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="completed" stackId="w" fill={COLOR_COMPLETED} name="Completed" />
            <Bar dataKey="notDone" stackId="w" fill={COLOR_CARRYOVER} name="Not done" />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

// ── Composed grid ────────────────────────────────────────────────────────────

export function TrendCharts({ stats }: Props) {
  if (stats.length === 0) return null;

  return (
    <div className="space-y-3">
      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        Charts
      </h4>
      <div className="grid gap-3 md:grid-cols-2">
        <VelocityChart stats={stats} />
        <IssueFlowChart stats={stats} />
        <PrThroughputChart stats={stats} />
        <IssueTypeChart stats={stats} />
      </div>
      <AssigneeWorkloadChart stats={stats} />
    </div>
  );
}
