import { TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type TrendPoint } from "./_shared";

export function VelocityTrend({ points }: { points: TrendPoint[] }) {
  const maxPts = Math.max(...points.map((p) => p.committed), 1);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <TrendingUp className="h-4 w-4" />
          Velocity Trend
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-end gap-2 h-28">
          {points.map((point) => (
            <div key={point.sprint.id} className="flex-1 flex flex-col items-center gap-1">
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {point.pct}%
              </span>
              <div
                className="w-full relative rounded-t-sm overflow-hidden bg-muted"
                style={{ height: `${(point.committed / maxPts) * 80}px`, minHeight: "8px" }}
              >
                <div
                  className={`absolute bottom-0 left-0 right-0 rounded-t-sm ${
                    point.pct >= 80
                      ? "bg-emerald-500"
                      : point.pct >= 60
                      ? "bg-amber-500"
                      : "bg-red-500"
                  }`}
                  style={{ height: `${point.pct}%` }}
                />
              </div>
            </div>
          ))}
        </div>
        <div className="flex gap-2 mt-2">
          {points.map((point) => (
            <div key={point.sprint.id} className="flex-1 text-center">
              <p
                className="text-[9px] text-muted-foreground truncate"
                title={point.sprint.name}
              >
                {point.sprint.name.replace(/sprint\s*/i, "S")}
              </p>
              <p className="text-[9px] text-muted-foreground tabular-nums">
                {point.completed}/{point.committed}
              </p>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-4 mt-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-muted inline-block" /> Committed
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-emerald-500 inline-block" /> Completed
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
