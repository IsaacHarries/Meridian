import React from "react";
import { r, uid, useBHGravity, SUCK_DUR } from "./_shared";
import { NovaEl } from "./nova";

// ── 4. Pulsar ──────────────────────────────────────────────────────────────────

export interface Pulsar { id: number; x: number; y: number; duration: number; period: number; }

export function PulsarEl({ pulsar, onDone }: { pulsar: Pulsar; onDone: () => void }) {
  const [novaDone, setNovaDone] = React.useState(false);
  const [showPulsar, setShowPulsar] = React.useState(false);
  const [vanishing, setVanishing] = React.useState(false);
  const { x, y, duration, period } = pulsar;
  const BEAM_LEN = 600;
  const { captured, gravRef, suckStyle } = useBHGravity(x, y);

  // Parent passes `() => rmPulsar(id)` — new ref every overlay render. Timer
  // effects must not depend on that identity or the 30s timeout keeps resetting.
  const onDoneRef = React.useRef(onDone);
  onDoneRef.current = onDone;

  // Stable callbacks so NovaEl's useEffect dependency array never sees a new
  // reference — inline lambdas would reset the cloud timers on every re-render
  // of PulsarEl (e.g. triggered by meteors completing during a shower).
  const handleNovaNearDone = React.useCallback(() => setShowPulsar(true), []);
  const handleNovaDone     = React.useCallback(() => setNovaDone(true), []);

  // Pulsar emerges after the gas cloud finishes collapsing (novaDone fires).
  // Also serves as a fallback when the nova is cut short by the black hole —
  // onNearDone is never called in that path, so we catch it here instead.
  React.useEffect(() => {
    if (novaDone) setShowPulsar(true);
  }, [novaDone]);

  React.useEffect(() => {
    if (!showPulsar) return;
    if (vanishing) {
      const t = setTimeout(() => onDoneRef.current(), 300);
      return () => clearTimeout(t);
    }
    // Same path as clicking the pulsar: shrink (m-se-vanish), then unmount.
    const t = setTimeout(() => setVanishing(true), duration + 200);
    return () => clearTimeout(t);
  }, [duration, showPulsar, vanishing]);

  // When captured, skip normal lifecycle for the pulsar phase
  React.useEffect(() => {
    if (!captured || !showPulsar) return;
    const t = setTimeout(() => onDoneRef.current(), SUCK_DUR + 100);
    return () => clearTimeout(t);
  }, [captured, showPulsar]);

  const beamStyle = (delay: string): React.CSSProperties => ({
    position: "absolute",
    width: `${BEAM_LEN}px`, height: "2px",
    left: "50%", top: "50%",
    transform: "translate(-50%, -50%)",
    background: "linear-gradient(90deg, transparent 0%, rgba(160,210,255,0.25) 20%, rgba(160,210,255,0.65) 50%, rgba(160,210,255,0.25) 80%, transparent 100%)",
    filter: "blur(1.5px)",
    animationName: "m-pulsar-spin",
    animationDuration: `${period}ms`,
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
    animationDelay: delay,
  });

  return (
    <>
      {!novaDone && <NovaEl nova={{ id: pulsar.id, x, y }} onNearDone={handleNovaNearDone} onDone={handleNovaDone} />}
      {showPulsar && (
        <div ref={gravRef} data-space-dismissable="true" onClick={() => !captured && !vanishing && setVanishing(true)} style={{
          position: "absolute", left: `${x}%`, top: `${y}%`,
          transform: `rotate(${pulsar.id * 47}deg)`,
          ...(captured ? suckStyle : { animation: vanishing ? "m-se-vanish 0.3s ease-in forwards" : "m-pulsar-fade-in 3s ease-out forwards" }),
          cursor: "pointer", pointerEvents: "auto",
        } as React.CSSProperties}>
          {/* Single light beam */}
          <div data-space-dismissable="true" style={beamStyle("0ms")} />
          {/* Pulsing core */}
          <div data-space-dismissable="true" style={{
            position: "absolute",
            width: "8px", height: "8px",
            left: "50%", top: "50%",
            borderRadius: "50%",
            background: "rgba(210,230,255,0.95)",
            animationName: "m-pulsar-core",
            animationDuration: `${period}ms`,
            animationTimingFunction: "ease-in-out",
            animationIterationCount: "infinite",
          }} />
        </div>
      )}
    </>
  );
}

/** Visible pulsar (beams + core) phase after the nova prelude — total ~30 s. */
const PULSAR_VISIBLE_MS = 30_000;

export function mkPulsar(): Pulsar {
  return {
    id: uid(),
    x: 10 + r() * 80,
    y: 10 + r() * 80,
    duration: PULSAR_VISIBLE_MS,
    period: 16000 + r() * 4800,
  };
}
