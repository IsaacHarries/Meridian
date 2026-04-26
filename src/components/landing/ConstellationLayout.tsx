import type { LandingLayoutProps } from "@/lib/landingLayouts";
import { CardBadge } from "./CardBadge";

export function ConstellationLayout({ cards, onNavigate }: LandingLayoutProps) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {cards.map((card) => (
        <button
          key={card.id}
          onClick={() => onNavigate(card.id)}
          className="group relative flex flex-col gap-3 rounded-xl border bg-card/60 p-4 text-left transition-colors hover:bg-accent/60 hover:border-primary/40 cursor-pointer overflow-hidden"
        >
          {/* Faint orbit decoration in the upper-right corner — picks up the
              meridian-line motif from the rest of the app. */}
          <svg
            className="absolute -top-6 -right-6 h-20 w-20 text-primary/10 group-hover:text-primary/25 transition-colors pointer-events-none"
            viewBox="0 0 80 80"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
          >
            <circle cx="40" cy="40" r="30" />
            <circle cx="40" cy="40" r="20" opacity="0.6" />
          </svg>
          {card.badge && <CardBadge badge={card.badge} className="absolute top-2 right-2 z-10" />}
          <card.Icon className="h-7 w-7 text-foreground/85 group-hover:text-primary transition-colors relative z-0" />
          <div className="relative z-0">
            <p className="text-sm font-medium leading-snug">{card.title}</p>
            <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{card.description}</p>
          </div>
        </button>
      ))}
    </div>
  );
}
