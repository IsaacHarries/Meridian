import { BgSvg, Stars, makeStars } from "./_shared";

// ── JWST star fields & galaxy helper ──────────────────────────────────────────

// All JWST backgrounds share the Deep Space star recipe (count 260,
// radius 0.3–1.0) so the foreground nebulae / galaxies stay the
// dominant visual element. Only the seed differs per background so
// stars land in different positions each time.
const STARS_CARINA        = makeStars(260, 333, 0.3, 1.0);
const STARS_PILLARS       = makeStars(260, 557, 0.3, 1.0);
const STARS_SOUTHERN_RING = makeStars(260, 889, 0.3, 1.0);
const STARS_PHANTOM       = makeStars(260, 123, 0.3, 1.0);
const STARS_TARANTULA     = makeStars(260, 777, 0.3, 1.0);
const STARS_STEPHANS      = makeStars(260, 666, 0.3, 1.0);
const STARS_CARTWHEEL     = makeStars(260, 999, 0.3, 1.0);

const JWST_STAR_COLOR = "hsl(220 30% 92%)";

// ── JWST backgrounds ───────────────────────────────────────────────────────────

// Webb 1: Carina Nebula — Cosmic Cliffs
// Orange-rust cliff of gas in the lower half, teal-blue upper atmosphere, stars bursting out.
export function JWSTCarinaBg() {
  return (
    <BgSvg>
      <defs>
        <filter id="car-xl" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="85" /></filter>
        <filter id="car-lg" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="55" /></filter>
        <filter id="car-md" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="35" /></filter>
      </defs>
      {/* Upper teal atmosphere */}
      <ellipse cx="640"  cy="100"  rx="900" ry="300" filter="url(#car-xl)" fill="hsl(188 72% 42%)" opacity="0.22" />
      <ellipse cx="900"  cy="50"   rx="600" ry="200" filter="url(#car-lg)" fill="hsl(200 78% 48%)" opacity="0.18" />
      {/* The cliff — dense orange-rust cloud mass at the bottom */}
      <ellipse cx="640"  cy="780"  rx="900" ry="380" filter="url(#car-xl)" fill="hsl(20  82% 42%)" opacity="0.38" />
      <ellipse cx="300"  cy="700"  rx="500" ry="280" filter="url(#car-lg)" fill="hsl(15  78% 36%)" opacity="0.30" />
      <ellipse cx="980"  cy="720"  rx="480" ry="250" filter="url(#car-lg)" fill="hsl(28  85% 48%)" opacity="0.25" />
      {/* Cliff edge — brighter gas where stars are forming */}
      <ellipse cx="640"  cy="480"  rx="700" ry="90"  filter="url(#car-md)" fill="hsl(38  90% 60%)" opacity="0.18" />
      <ellipse cx="400"  cy="440"  rx="300" ry="60"  filter="url(#car-md)" fill="hsl(45  95% 68%)" opacity="0.14" />
      {/* Stars — concentrated near the cliff edge, sparser above */}
      <Stars stars={STARS_CARINA} color={JWST_STAR_COLOR} />
    </BgSvg>
  );
}

// Webb 2: Pillars of Creation
// Three iconic dark dust columns rising from orange gas. Purple-blue outer nebula.
export function JWSTPillarsBg() {
  return (
    <BgSvg>
      <defs>
        <filter id="pil-xl" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="80" /></filter>
        <filter id="pil-lg" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="55" /></filter>
        <filter id="pil-md" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="30" /></filter>
      </defs>
      {/* Outer purple-blue nebula */}
      <ellipse cx="640"  cy="400" rx="800" ry="500" filter="url(#pil-xl)" fill="hsl(268 58% 45%)" opacity="0.28" />
      <ellipse cx="200"  cy="300" rx="400" ry="350" filter="url(#pil-lg)" fill="hsl(220 68% 48%)" opacity="0.20" />
      <ellipse cx="1100" cy="500" rx="380" ry="300" filter="url(#pil-lg)" fill="hsl(240 65% 48%)" opacity="0.18" />
      {/* Surrounding warm orange-rust gas */}
      <ellipse cx="640"  cy="600" rx="700" ry="350" filter="url(#pil-xl)" fill="hsl(20  78% 40%)" opacity="0.30" />
      <ellipse cx="400"  cy="500" rx="400" ry="280" filter="url(#pil-lg)" fill="hsl(15  75% 36%)" opacity="0.22" />
      {/* The pillars — tall dark dust columns */}
      <ellipse cx="420"  cy="550" rx="55"  ry="280" filter="url(#pil-md)" fill="hsl(18  65% 22%)" opacity="0.55" />
      <ellipse cx="640"  cy="600" rx="45"  ry="320" filter="url(#pil-md)" fill="hsl(16  60% 20%)" opacity="0.55" />
      <ellipse cx="840"  cy="580" rx="38"  ry="260" filter="url(#pil-md)" fill="hsl(20  62% 24%)" opacity="0.50" />
      {/* Glowing pillar tips */}
      <ellipse cx="420"  cy="270" rx="40"  ry="25"  filter="url(#pil-md)" fill="hsl(38  90% 62%)" opacity="0.25" />
      <ellipse cx="640"  cy="280" rx="35"  ry="20"  filter="url(#pil-md)" fill="hsl(40  88% 60%)" opacity="0.22" />
      <ellipse cx="840"  cy="320" rx="30"  ry="18"  filter="url(#pil-md)" fill="hsl(36  85% 58%)" opacity="0.20" />
      <Stars stars={STARS_PILLARS} color={JWST_STAR_COLOR} />
    </BgSvg>
  );
}

// Webb 3: Southern Ring Nebula
// Concentric rings from a dying star. Blue inner ring, orange outer ring.
export function JWSTSouthernRingBg() {
  return (
    <BgSvg>
      <defs>
        <filter id="sr-lg" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="50" /></filter>
        <filter id="sr-md" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="28" /></filter>
        <filter id="sr-sm" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="12" /></filter>
      </defs>
      <Stars stars={STARS_SOUTHERN_RING} color={JWST_STAR_COLOR} />
      {/* Outermost ring — red-orange */}
      <ellipse cx="640" cy="400" rx="480" ry="340" fill="none"
        stroke="hsl(12 88% 52%)" strokeWidth="60" filter="url(#sr-lg)" opacity="0.22" />
      {/* Outer ring — rose */}
      <ellipse cx="640" cy="400" rx="380" ry="270" fill="none"
        stroke="hsl(340 75% 58%)" strokeWidth="45" filter="url(#sr-md)" opacity="0.28" />
      {/* Mid ring — blue */}
      <ellipse cx="640" cy="400" rx="270" ry="192" fill="none"
        stroke="hsl(208 82% 58%)" strokeWidth="50" filter="url(#sr-md)" opacity="0.32" />
      {/* Inner ring — vivid cyan */}
      <ellipse cx="640" cy="400" rx="160" ry="114" fill="none"
        stroke="hsl(192 90% 62%)" strokeWidth="40" filter="url(#sr-sm)" opacity="0.38" />
      {/* Central dying star glow */}
      <ellipse cx="640" cy="400" rx="55"  ry="40"  filter="url(#sr-sm)" fill="hsl(48 100% 78%)" opacity="0.55" />
      <ellipse cx="640" cy="400" rx="20"  ry="14"  filter="url(#sr-sm)" fill="hsl(0   0% 100%)" opacity="0.70" />
      {/* Faint outer shell */}
      <ellipse cx="640" cy="400" rx="570" ry="405" fill="none"
        stroke="hsl(25 70% 48%)" strokeWidth="30" filter="url(#sr-lg)" opacity="0.12" />
    </BgSvg>
  );
}

// Webb 4: Phantom Galaxy (M74)
// Clean spiral structure — golden core, blue star-forming arms, pink outer dust.
export function JWSTPhantomBg() {
  return (
    <BgSvg>
      <defs>
        <filter id="ph-xl" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="75" /></filter>
        <filter id="ph-lg" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="45" /></filter>
        <filter id="ph-md" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="22" /></filter>
        <filter id="ph-sm" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="10" /></filter>
      </defs>
      <Stars stars={STARS_PHANTOM} color={JWST_STAR_COLOR} />
      {/* Outer faint halo */}
      <ellipse cx="640" cy="400" rx="420" ry="380" filter="url(#ph-xl)" fill="hsl(270 45% 40%)" opacity="0.18" />
      {/* Outer spiral arm traces — pink/rose dust */}
      <ellipse cx="640" cy="400" rx="340" ry="200" filter="url(#ph-lg)" fill="hsl(330 68% 55%)" opacity="0.20"
        transform="rotate(35 640 400)" />
      <ellipse cx="640" cy="400" rx="300" ry="170" filter="url(#ph-lg)" fill="hsl(350 65% 52%)" opacity="0.18"
        transform="rotate(-40 640 400)" />
      {/* Mid spiral arms — blue star-forming regions */}
      <ellipse cx="640" cy="400" rx="240" ry="120" filter="url(#ph-md)" fill="hsl(205 82% 58%)" opacity="0.28"
        transform="rotate(20 640 400)" />
      <ellipse cx="640" cy="400" rx="210" ry="100" filter="url(#ph-md)" fill="hsl(215 78% 55%)" opacity="0.24"
        transform="rotate(-55 640 400)" />
      {/* Inner arms — brighter blue */}
      <ellipse cx="640" cy="400" rx="140" ry="55"  filter="url(#ph-md)" fill="hsl(195 88% 62%)" opacity="0.30"
        transform="rotate(10 640 400)" />
      <ellipse cx="640" cy="400" rx="120" ry="48"  filter="url(#ph-md)" fill="hsl(200 85% 60%)" opacity="0.26"
        transform="rotate(-70 640 400)" />
      {/* Bright golden core */}
      <ellipse cx="640" cy="400" rx="60"  ry="52"  filter="url(#ph-sm)" fill="hsl(45 95% 72%)"  opacity="0.55" />
      <ellipse cx="640" cy="400" rx="22"  ry="18"  filter="url(#ph-sm)" fill="hsl(50 100% 85%)" opacity="0.80" />
    </BgSvg>
  );
}

// Webb 5: Tarantula Nebula (30 Doradus)
// Vivid blue-white core of hot young stars, orange-red surrounding gas, dense star field.
export function JWSTTarantulaBg() {
  return (
    <BgSvg>
      <defs>
        <filter id="tar-xl" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="85" /></filter>
        <filter id="tar-lg" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="55" /></filter>
        <filter id="tar-md" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="30" /></filter>
        <filter id="tar-sm" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="14" /></filter>
      </defs>
      {/* Outer diffuse gas clouds — orange and red */}
      <ellipse cx="640"  cy="380" rx="800" ry="550" filter="url(#tar-xl)" fill="hsl(15  80% 42%)" opacity="0.25" />
      <ellipse cx="380"  cy="300" rx="500" ry="380" filter="url(#tar-lg)" fill="hsl(8   75% 38%)" opacity="0.22" />
      <ellipse cx="920"  cy="500" rx="420" ry="320" filter="url(#tar-lg)" fill="hsl(22  82% 45%)" opacity="0.20" />
      {/* Streaming gas filaments */}
      <ellipse cx="200"  cy="200" rx="350" ry="120" filter="url(#tar-md)" fill="hsl(340 65% 50%)" opacity="0.20"
        transform="rotate(-25 200 200)" />
      <ellipse cx="1050" cy="600" rx="320" ry="100" filter="url(#tar-md)" fill="hsl(30  80% 52%)" opacity="0.18"
        transform="rotate(20 1050 600)" />
      {/* Central hot nebula — blue-white */}
      <ellipse cx="640"  cy="380" rx="300" ry="240" filter="url(#tar-lg)" fill="hsl(198 90% 55%)" opacity="0.35" />
      <ellipse cx="640"  cy="380" rx="160" ry="130" filter="url(#tar-md)" fill="hsl(205 95% 65%)" opacity="0.42" />
      {/* Blazing core cluster */}
      <ellipse cx="640"  cy="380" rx="70"  ry="58"  filter="url(#tar-sm)" fill="hsl(210 100% 80%)" opacity="0.60" />
      <ellipse cx="640"  cy="380" rx="28"  ry="22"  filter="url(#tar-sm)" fill="hsl(0   0%  100%)" opacity="0.75" />
      <Stars stars={STARS_TARANTULA} color={JWST_STAR_COLOR} />
    </BgSvg>
  );
}

// Webb 6: Stephan's Quintet — five galaxies in close proximity with a blue shock wave
export function JWSTStephansBg() {
  return (
    <BgSvg>
      <defs>
        <filter id="sq-lg" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="55" /></filter>
        <filter id="sq-md" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="30" /></filter>
        <filter id="sq-sm" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="14" /></filter>
      </defs>
      <Stars stars={STARS_STEPHANS} color={JWST_STAR_COLOR} />
      {/* The five galaxies */}
      {/* NGC 7320 — foreground galaxy, bluer */}
      <ellipse cx="260"  cy="560" rx="110" ry="65"  filter="url(#sq-md)" fill="hsl(210 75% 58%)" opacity="0.42"
        transform="rotate(-20 260 560)" />
      {/* NGC 7318a — interacting pair */}
      <ellipse cx="700"  cy="340" rx="90"  ry="55"  filter="url(#sq-md)" fill="hsl(45  88% 62%)" opacity="0.45"
        transform="rotate(15 700 340)" />
      {/* NGC 7318b — interacting with a */}
      <ellipse cx="800"  cy="420" rx="80"  ry="48"  filter="url(#sq-md)" fill="hsl(38  82% 58%)" opacity="0.40"
        transform="rotate(-10 800 420)" />
      {/* NGC 7319 */}
      <ellipse cx="980"  cy="260" rx="75"  ry="50"  filter="url(#sq-md)" fill="hsl(28  80% 55%)" opacity="0.42"
        transform="rotate(30 980 260)" />
      {/* NGC 7317 */}
      <ellipse cx="580"  cy="580" rx="65"  ry="40"  filter="url(#sq-md)" fill="hsl(270 62% 58%)" opacity="0.38"
        transform="rotate(-35 580 580)" />
      {/* Blue intergalactic shock wave between the interacting pair */}
      <ellipse cx="760"  cy="400" rx="200" ry="320" filter="url(#sq-lg)" fill="hsl(212 88% 55%)" opacity="0.22"
        transform="rotate(8 760 400)" />
      <ellipse cx="760"  cy="400" rx="120" ry="220" filter="url(#sq-md)" fill="hsl(205 92% 62%)" opacity="0.18"
        transform="rotate(8 760 400)" />
      {/* Intergalactic gas streams */}
      <ellipse cx="640"  cy="450" rx="500" ry="80"  filter="url(#sq-lg)" fill="hsl(35  72% 50%)" opacity="0.14"
        transform="rotate(-5 640 450)" />
    </BgSvg>
  );
}

// Webb 7: Cartwheel Galaxy — ring galaxy with vivid outer ring and radial spokes
export function JWSTCartwheelBg() {
  return (
    <BgSvg>
      <defs>
        <filter id="cw-lg" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="50" /></filter>
        <filter id="cw-md" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="25" /></filter>
        <filter id="cw-sm" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="10" /></filter>
      </defs>
      <Stars stars={STARS_CARTWHEEL} color={JWST_STAR_COLOR} />
      {/* Outer halo glow */}
      <ellipse cx="640" cy="400" rx="440" ry="400" filter="url(#cw-lg)" fill="hsl(330 60% 45%)" opacity="0.18" />
      {/* Outer ring — pink/rose with hot star-forming clumps */}
      <ellipse cx="640" cy="400" rx="360" ry="328" fill="none"
        stroke="hsl(328 75% 58%)" strokeWidth="48" filter="url(#cw-md)" opacity="0.38" />
      {/* Outer ring texture — bright blue spots (young stars) */}
      <ellipse cx="640" cy="400" rx="360" ry="328" fill="none"
        stroke="hsl(195 85% 65%)" strokeWidth="20" filter="url(#cw-sm)" opacity="0.28" />
      {/* Radial spokes */}
      {[0, 45, 90, 135, 180, 225, 270, 315].map((deg, i) => {
        const rad = (deg * Math.PI) / 180;
        const x1 = 640 + 110 * Math.cos(rad), y1 = 400 + 100 * Math.sin(rad);
        const x2 = 640 + 330 * Math.cos(rad), y2 = 400 + 300 * Math.sin(rad);
        return (
          <line key={i}
            x1={x1.toFixed(1)} y1={y1.toFixed(1)}
            x2={x2.toFixed(1)} y2={y2.toFixed(1)}
            stroke="hsl(32 78% 55%)" strokeWidth="6"
            filter="url(#cw-sm)" opacity="0.22" />
        );
      })}
      {/* Inner ring */}
      <ellipse cx="640" cy="400" rx="110" ry="100" fill="none"
        stroke="hsl(200 80% 60%)" strokeWidth="30" filter="url(#cw-md)" opacity="0.38" />
      {/* Core */}
      <ellipse cx="640" cy="400" rx="45"  ry="40"  filter="url(#cw-sm)" fill="hsl(45 95% 72%)"  opacity="0.60" />
      <ellipse cx="640" cy="400" rx="16"  ry="14"  filter="url(#cw-sm)" fill="hsl(0  0%  100%)" opacity="0.80" />
      {/* Companion galaxies */}
      <ellipse cx="980" cy="200" rx="28" ry="18" filter="url(#cw-sm)" fill="hsl(45 85% 65%)" opacity="0.42"
        transform="rotate(30 980 200)" />
      <ellipse cx="250" cy="600" rx="22" ry="14" filter="url(#cw-sm)" fill="hsl(200 75% 62%)" opacity="0.38"
        transform="rotate(-20 250 600)" />
    </BgSvg>
  );
}
