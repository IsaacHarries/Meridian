import { useMemo } from "react";
import { BgSvg, W, H } from "./_shared";

// 15. Honeycomb — computed hex grid (accent-tinted)
export function HoneycombBg() {
  const paths = useMemo(() => {
    const r = 48, h = r * Math.sqrt(3) / 2;
    const colSpacing = 2 * h, rowSpacing = 1.5 * r;
    const result: string[] = [];
    for (let row = -1; row <= Math.ceil(H / rowSpacing) + 1; row++) {
      for (let col = -1; col <= Math.ceil(W / colSpacing) + 1; col++) {
        const cx = col * colSpacing + (row % 2 === 0 ? 0 : h);
        const cy = row * rowSpacing;
        result.push(
          `M${cx.toFixed(1)},${(cy - r).toFixed(1)} ` +
          `L${(cx + h).toFixed(1)},${(cy - r / 2).toFixed(1)} ` +
          `L${(cx + h).toFixed(1)},${(cy + r / 2).toFixed(1)} ` +
          `L${cx.toFixed(1)},${(cy + r).toFixed(1)} ` +
          `L${(cx - h).toFixed(1)},${(cy + r / 2).toFixed(1)} ` +
          `L${(cx - h).toFixed(1)},${(cy - r / 2).toFixed(1)} Z`
        );
      }
    }
    return result;
  }, []);

  return (
    <BgSvg>
      {paths.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="hsl(var(--primary))" strokeWidth="0.8" opacity="0.14" />
      ))}
    </BgSvg>
  );
}

// 16. Waves — sine wave lines (accent-tinted)
export function WavesBg() {
  const wavePaths = useMemo(() => {
    return Array.from({ length: 10 }, (_, i) => {
      const baseY = 60 + i * 82;
      const amplitude = 22 + i * 4;
      const freq = 0.0035 + i * 0.0003;
      const phase = i * 1.1;
      const pts = Array.from({ length: 130 }, (_, j) => {
        const x = j * 10;
        const y = baseY + amplitude * Math.sin(x * freq * Math.PI * 2 + phase);
        return `${j === 0 ? "M" : "L"}${x},${y.toFixed(1)}`;
      });
      return pts.join(" ");
    });
  }, []);

  return (
    <BgSvg>
      {wavePaths.map((d, i) => (
        <path
          key={i} d={d} fill="none"
          stroke="hsl(var(--primary))"
          strokeWidth={i % 3 === 0 ? 1.2 : 0.75}
          opacity={0.08 + (i % 3) * 0.03}
        />
      ))}
    </BgSvg>
  );
}

// 17. Circuit — PCB-style traces (accent-tinted)
export function CircuitBg() {
  const { lines, dots } = useMemo(() => {
    const tileW = 80, tileH = 80;
    const lines: { x1: number; y1: number; x2: number; y2: number }[] = [];
    const dots: { cx: number; cy: number }[] = [];

    // Deterministic pseudo-random using seed
    const rand = (seed: number) => {
      const x = Math.sin(seed) * 10000;
      return x - Math.floor(x);
    };

    let seed = 0;
    for (let row = 0; row * tileH <= H + tileH; row++) {
      for (let col = 0; col * tileW <= W + tileW; col++) {
        const x = col * tileW;
        const y = row * tileH;
        const r = rand(seed++);
        if (r < 0.4) {
          // Horizontal then vertical (L-shape)
          const midX = x + tileW * 0.6;
          lines.push({ x1: x, y1: y + 20, x2: midX, y2: y + 20 });
          lines.push({ x1: midX, y1: y + 20, x2: midX, y2: y + tileH });
          dots.push({ cx: x, cy: y + 20 });
          dots.push({ cx: midX, cy: y + 20 });
        } else if (r < 0.7) {
          // Vertical then horizontal
          const midY = y + tileH * 0.4;
          lines.push({ x1: x + 40, y1: y, x2: x + 40, y2: midY });
          lines.push({ x1: x + 40, y1: midY, x2: x + tileW, y2: midY });
          dots.push({ cx: x + 40, cy: midY });
          dots.push({ cx: x + tileW, cy: midY });
        }
        seed++;
      }
    }
    return { lines, dots };
  }, []);

  return (
    <BgSvg>
      {lines.map((l, i) => (
        <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
          stroke="hsl(var(--primary))" strokeWidth="0.8" opacity="0.14" />
      ))}
      {dots.map((d, i) => (
        <circle key={i} cx={d.cx} cy={d.cy} r="2.5"
          fill="none" stroke="hsl(var(--primary))" strokeWidth="0.8" opacity="0.18" />
      ))}
    </BgSvg>
  );
}

// 18. Blueprint — engineering grid
export function BlueprintBg() {
  const { minorLines, majorLines } = useMemo(() => {
    const minor: { x1: number; y1: number; x2: number; y2: number }[] = [];
    const major: { x1: number; y1: number; x2: number; y2: number }[] = [];
    const step = 40;
    for (let x = 0; x <= W; x += step) {
      (x % 200 === 0 ? major : minor).push({ x1: x, y1: 0, x2: x, y2: H });
    }
    for (let y = 0; y <= H; y += step) {
      (y % 200 === 0 ? major : minor).push({ x1: 0, y1: y, x2: W, y2: y });
    }
    return { minorLines: minor, majorLines: major };
  }, []);

  return (
    <BgSvg>
      {minorLines.map((l, i) => (
        <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
          stroke="hsl(210 75% 52%)" strokeWidth="0.5" opacity="0.10" />
      ))}
      {majorLines.map((l, i) => (
        <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
          stroke="hsl(210 75% 52%)" strokeWidth="1" opacity="0.18" />
      ))}
      {/* Center crosshair marks */}
      {Array.from({ length: Math.ceil(W / 200) + 1 }, (_, ci) =>
        Array.from({ length: Math.ceil(H / 200) + 1 }, (_, ri) => {
          const cx = ci * 200, cy = ri * 200;
          return (
            <g key={`${ci}-${ri}`}>
              <line x1={cx - 6} y1={cy} x2={cx + 6} y2={cy} stroke="hsl(210 75% 52%)" strokeWidth="0.8" opacity="0.25" />
              <line x1={cx} y1={cy - 6} x2={cx} y2={cy + 6} stroke="hsl(210 75% 52%)" strokeWidth="0.8" opacity="0.25" />
            </g>
          );
        })
      )}
    </BgSvg>
  );
}

// 19. Topographic — concentric contour lines (accent-tinted)
export function TopographicBg() {
  const curves = useMemo(() => {
    return Array.from({ length: 18 }, (_, i) => {
      const scaleA = 80 + i * 55;
      const scaleB = 60 + i * 45;
      return { scaleA, scaleB, opacity: 0.20 - i * 0.007 };
    });
  }, []);

  return (
    <BgSvg>
      {curves.map((c, i) => (
        <g key={i}>
          <ellipse cx="900" cy="-50" rx={c.scaleA} ry={c.scaleA * 0.7}
            fill="none" stroke="hsl(var(--primary))" strokeWidth="0.75"
            opacity={Math.max(c.opacity, 0.04)}
            transform={`rotate(${i * 7}, 900, -50)`}
          />
          <ellipse cx="200" cy="850" rx={c.scaleB} ry={c.scaleB * 0.65}
            fill="none" stroke="hsl(var(--primary))" strokeWidth="0.75"
            opacity={Math.max(c.opacity * 0.8, 0.03)}
            transform={`rotate(${i * -5}, 200, 850)`}
          />
        </g>
      ))}
    </BgSvg>
  );
}
