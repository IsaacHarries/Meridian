import React from "react";
import {
  isSpaceBg,
  r,
  EV_NOVA,
  EV_BH,
  EV_COMET,
  EV_PULSAR,
  EV_METEORS,
  EV_WORMHOLE,
  EV_SHOOTING_STAR,
  EV_CLEAR,
  EV_ENABLED,
  SPACE_FX_TOGGLES_EVENT,
  SPACE_FX_BH_GRAVITY_EVENT,
  type SpaceEffectKind,
  loadKindToggles,
  loadBhGravityPreference,
  ensureKF,
  BHContext,
} from "./_shared";
import { type Nova, NovaEl, mkNova } from "./nova";
import { type BH, BHEl, mkBH } from "./blackHole";
import { type Comet, CometEl, mkComet } from "./comet";
import { type Pulsar, PulsarEl, mkPulsar } from "./pulsar";
import { type Meteor, MeteorEl, mkMeteors } from "./meteor";
import { type WH, WormholeEl, mkWH } from "./wormhole";
import { type SStar, ShootingStarEl, mkShootingStars } from "./shootingStar";

// ── SpaceEffectsOverlay ───────────────────────────────────────────────────────

interface State {
  novas: Nova[];
  bh: BH | null;
  comets: Comet[];
  pulsars: Pulsar[];
  meteors: Meteor[];
  wormholes: WH[];
  shootingStars: SStar[];
}

const EMPTY: State = { novas: [], bh: null, comets: [], pulsars: [], meteors: [], wormholes: [], shootingStars: [] };

export function SpaceEffectsOverlay({ bgId }: { bgId: string }) {
  const space = isSpaceBg(bgId);
  const [st, setSt] = React.useState<State>(EMPTY);
  const [enabled, setEnabled] = React.useState(true);
  const [kinds, setKinds] = React.useState<Record<SpaceEffectKind, boolean>>(() =>
    loadKindToggles()
  );
  // Gravity turns off the moment the BH starts vanishing, even though the
  // visual fade-out continues for another ~2.8 s.
  const [bhGravityActive, setBhGravityActive] = React.useState(false);
  /** User toggle from FX drawer — when false, BH still renders but does not pull other effects */
  const [bhGravityUserEnabled, setBhGravityUserEnabled] = React.useState(() =>
    loadBhGravityPreference()
  );

  const kindsRef = React.useRef(kinds);
  kindsRef.current = kinds;
  const enabledRef = React.useRef(enabled);
  enabledRef.current = enabled;

  const onBHVanishing = React.useCallback(() => setBhGravityActive(false), []);

  React.useEffect(() => {
    const h = (e: Event) => {
      const detail = { ...(e as CustomEvent<Record<SpaceEffectKind, boolean>>).detail };
      setKinds(detail);
      // Same turn as the drawer toggle — clear live instances for any channel now off
      // (avoids races vs a separate effect and stale kindsRef in scheduled spawns).
      setSt((p) => ({
        ...p,
        novas:         detail.novas ? p.novas : [],
        comets:        detail.comets ? p.comets : [],
        pulsars:       detail.pulsars ? p.pulsars : [],
        meteors:       detail.meteors ? p.meteors : [],
        wormholes:     detail.wormholes ? p.wormholes : [],
        shootingStars: detail.shootingStars ? p.shootingStars : [],
        bh:            detail.blackHole ? p.bh : null,
      }));
      if (!detail.blackHole) setBhGravityActive(false);
    };
    window.addEventListener(SPACE_FX_TOGGLES_EVENT, h);
    return () => window.removeEventListener(SPACE_FX_TOGGLES_EVENT, h);
  }, []);

  React.useEffect(() => {
    const h = (e: Event) =>
      setBhGravityUserEnabled((e as CustomEvent<boolean>).detail);
    window.addEventListener(SPACE_FX_BH_GRAVITY_EVENT, h);
    return () => window.removeEventListener(SPACE_FX_BH_GRAVITY_EVENT, h);
  }, []);

  const addNova    = React.useCallback(() => setSt(p => ({ ...p, novas:    [...p.novas, mkNova()] })), []);
  const addBH      = React.useCallback((x?: number, y?: number) => setSt(p => {
    if (p.bh) return p;
    setBhGravityActive(true);
    return { ...p, bh: mkBH(x, y) };
  }), []);
  const addComet   = React.useCallback(() => setSt(p => ({ ...p, comets:   [...p.comets, mkComet()] })), []);
  const addPulsar     = React.useCallback(() => setSt(p => p.pulsars.length > 0 ? p : ({ ...p, pulsars: [mkPulsar()] })), []);
  const replacePulsar = React.useCallback(() => setSt(p => ({ ...p, pulsars: [mkPulsar()] })), []);
  const addMeteors = React.useCallback(() => setSt(p => ({ ...p, meteors:  [...p.meteors, ...mkMeteors()] })), []);
  const addWH      = React.useCallback(() => setSt(p => ({ ...p, wormholes:[...p.wormholes, mkWH()] })), []);
  const replaceWH  = React.useCallback(() => setSt(p => ({ ...p, wormholes: [mkWH()] })), []);
  const addShootingStars = React.useCallback((count: number) => setSt(p => ({ ...p, shootingStars: [...p.shootingStars, ...mkShootingStars(count)] })), []);

  // Forward clicks through the UI layer to animation elements underneath.
  // Because GlobalForeground sits at z-[0] behind the z-[1] content wrapper,
  // native hit-testing never reaches the animation elements. We intercept every
  // trusted document click in capture phase, find any [data-space-dismissable]
  // element at that point via elementsFromPoint, and dispatch a synthetic click
  // on it so React's onClick handler fires normally.
  //
  // We stop before forwarding if any real interactive UI element (button, link,
  // input, etc.) appears in front of the space element — those must win.
  React.useEffect(() => {
    const INTERACTIVE = new Set(["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "LABEL", "SUMMARY"]);
    function isInteractive(el: Element): boolean {
      const h = el as HTMLElement;
      return (
        INTERACTIVE.has(h.tagName) ||
        h.role === "button" ||
        h.getAttribute("role") === "button" ||
        h.tabIndex >= 0 ||
        h.isContentEditable
      );
    }

    function handleClick(e: MouseEvent) {
      if (!e.isTrusted) return;
      const els = document.elementsFromPoint(e.clientX, e.clientY);
      // Walk front-to-back; if we hit an interactive element before a space
      // element, the real UI gets the click — don't forward.
      for (const el of els) {
        if ((el as HTMLElement).dataset?.spaceDismissable === "true") {
          el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          break;
        }
        if (isInteractive(el)) break;
      }
    }
    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, []);

  // Listen for manual fire events, clear, and enabled toggle
  React.useEffect(() => {
    ensureKF();
    const clearAll = () => setSt(EMPTY);
    const onEnabled = (e: Event) => {
      const on = (e as CustomEvent<boolean>).detail;
      setEnabled(on);
      if (!on) setSt(EMPTY);
    };
    const pairs: [string, () => void][] = [
      [EV_NOVA, () => {
        if (enabledRef.current && kindsRef.current.novas) addNova();
      }],
      [EV_BH, () => {
        if (enabledRef.current && kindsRef.current.blackHole) addBH();
      }],
      [EV_COMET, () => {
        if (enabledRef.current && kindsRef.current.comets) addComet();
      }],
      [EV_PULSAR, () => {
        if (enabledRef.current && kindsRef.current.pulsars) replacePulsar();
      }],
      [EV_METEORS, () => {
        if (enabledRef.current && kindsRef.current.meteors) addMeteors();
      }],
      [EV_WORMHOLE, () => {
        if (enabledRef.current && kindsRef.current.wormholes) replaceWH();
      }],
      [EV_SHOOTING_STAR, () => {
        if (enabledRef.current && kindsRef.current.shootingStars) {
          addShootingStars(1 + Math.floor(Math.random() * 3));
        }
      }],
    ];
    pairs.forEach(([ev, fn]) => window.addEventListener(ev, fn));
    window.addEventListener(EV_CLEAR, clearAll);
    window.addEventListener(EV_ENABLED, onEnabled);
    return () => {
      pairs.forEach(([ev, fn]) => window.removeEventListener(ev, fn));
      window.removeEventListener(EV_CLEAR, clearAll);
      window.removeEventListener(EV_ENABLED, onEnabled);
    };
  }, [addNova, addBH, addComet, replacePulsar, addMeteors, replaceWH, addShootingStars]);

  // Auto-schedule random effects when on a space background and effects are enabled
  React.useEffect(() => {
    if (!space || !enabled) { if (!space) setSt(EMPTY); return; }
    ensureKF();

    const timers: ReturnType<typeof setTimeout>[] = [];
    const sched = (fn: () => void, minMs: number, maxMs: number) => {
      const tick = () => {
        fn();
        timers.push(setTimeout(tick, minMs + r() * (maxMs - minMs)));
      };
      timers.push(setTimeout(tick, minMs + r() * (maxMs - minMs)));
    };

    sched(() => { if (kindsRef.current.comets) addComet(); }, 18_000, 55_000);
    sched(() => { if (kindsRef.current.pulsars) addPulsar(); }, 55_000, 160_000);
    sched(() => { if (kindsRef.current.meteors) addMeteors(); }, 80_000, 220_000);
    sched(() => { if (kindsRef.current.wormholes) addWH(); }, 3_600_000, 7_200_000);
    // Shooting stars: every 2.5–8 s, occasionally 2 at once
    sched(() => {
      if (!kindsRef.current.shootingStars) return;
      addShootingStars(Math.random() < 0.25 ? 2 : 1);
    }, 2_500, 8_000);

    // Black hole: random cadence; addBH no-ops if one is already active
    sched(() => {
      if (kindsRef.current.blackHole) addBH();
    }, 5 * 60_000, 18 * 60_000);

    return () => timers.forEach(clearTimeout);
  }, [space, enabled, addComet, addPulsar, addMeteors, addWH, addBH, addShootingStars]);

  const rmNova    = (id: number) => setSt(p => ({ ...p, novas:         p.novas.filter(x => x.id !== id) }));
  const rmComet   = (id: number) => setSt(p => ({ ...p, comets:        p.comets.filter(x => x.id !== id) }));
  const rmPulsar  = (id: number) => setSt(p => ({ ...p, pulsars:       p.pulsars.filter(x => x.id !== id) }));
  const rmMeteor  = (id: number) => setSt(p => ({ ...p, meteors:       p.meteors.filter(x => x.id !== id) }));
  const rmWH      = (id: number) => setSt(p => ({ ...p, wormholes:     p.wormholes.filter(x => x.id !== id) }));
  const rmStar    = (id: number) => setSt(p => ({ ...p, shootingStars: p.shootingStars.filter(x => x.id !== id) }));

  const empty = !st.bh && !st.novas.length && !st.comets.length && !st.pulsars.length && !st.meteors.length && !st.wormholes.length && !st.shootingStars.length;
  if (!space && empty) return null;

  return (
    <BHContext.Provider
      value={
        st.bh && bhGravityActive && bhGravityUserEnabled
          ? { x: st.bh.x, y: st.bh.y }
          : null
      }
    >
      <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
        {st.novas.map(n =>
          <NovaEl key={n.id} nova={n} onDone={() => rmNova(n.id)} />
        )}
        {st.bh &&
          <BHEl bh={st.bh} onVanishing={onBHVanishing} onDone={() => { setSt(p => ({ ...p, bh: null })); setBhGravityActive(false); }} />
        }
        {st.comets.map(c =>
          <CometEl key={c.id} comet={c} onDone={() => rmComet(c.id)} />
        )}
        {st.pulsars.map(p =>
          <PulsarEl key={p.id} pulsar={p} onDone={() => rmPulsar(p.id)} />
        )}
        {st.meteors.map(m =>
          <MeteorEl key={m.id} meteor={m} onDone={() => rmMeteor(m.id)} />
        )}
        {st.wormholes.map(w =>
          <WormholeEl key={w.id} wh={w} onDone={() => rmWH(w.id)} />
        )}
        {st.shootingStars.map(s =>
          <ShootingStarEl key={s.id} star={s} onDone={() => rmStar(s.id)} />
        )}
      </div>
    </BHContext.Provider>
  );
}
