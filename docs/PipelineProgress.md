# PipelineProgress Component

**File**: `src/components/PipelineProgress.tsx`

This is a dual-mode animated SVG component (960×116 viewBox). It renders the Meridian logo
when idle and expands into a full pipeline progress indicator when the user enters the
Implement a Ticket workflow.

---

## Two Modes

### Logo Mode (`activeStep === undefined`)
Renders the Meridian brand mark: a center dot with a halo ring, nine satellite dots arranged
around two ellipse arcs (the "meridian lines"), and the arcs themselves. The geometry is
derived directly from `Meridian_no_bg.svg` and mapped into component space via:

```
translate(anchor_cx, 38) · scale(0.55) · translate(-121.052, -87.969)
```

where `anchor_cx` is 480 (centred) or 120 (left-aligned, used in the ImplementTicketScreen
header). The logo group is rendered as a real SVG `<g>` element whose opacity animates to
0 when the pipeline activates — it is never unmounted.

### Pipeline Mode (`activeStep = 0–7`)
Renders eight pipeline step nodes arranged on the top arc of a very large circle
(radius `R_CIRC = 1066`, centre at `(ACTIVE_X=400, CY=1104)`). Because the radius is so
large, the visible portion of the arc in the 960×116 viewBox looks nearly flat, giving a
subtle upward curve. The active step node sits at the apex (`y = NODE_Y = 38`) with a
halo ring around it. A step label cross-fades below the active node.

The eight pipeline steps correspond 1:1 to the agent pipeline:
`Grooming → Impact Analysis → Triage → Implementation → Test Generation → Code Review → PR Description → Retrospective`

---

## The Meridian Lines (Arcs)

Both modes show two concentric ellipse arcs styled as the meridian lines from the logo:

- **Logo mode**: compact ellipses matching the original SVG proportions, centred under the
  logo dot cluster.
- **Pipeline mode**: the outer arc expands to match the curvature of the node circle
  (`rx = ry = R_CIRC`); the inner arc uses an elongated ellipse (`rx ≈ 472, ry ≈ 891`)
  that preserves the logo's inner/outer aspect ratio. Both arc tops sit at `PIPE_ARC_TOP`
  (a few pixels below the nodes), so nodes always appear *above* the meridian lines — the
  same spatial relationship as in the compact logo. The arcs animate their `cx/cy/rx/ry`
  directly via `setAttribute` in the RAF loop.

---

## The Nodes

There are three conceptual groups of nodes, all rendered as SVG `<circle>` elements:

### 1. Pipeline nodes — `nodeRefs` (8 circles, `nodes[]`)
One circle per pipeline step, managed by `nodeRefs`. Their arc positions are computed by
`pipePos(i, s)` which places step `i` at angle `(-90 + (i - s) × 7°)` on the `R_CIRC`
circle. Opacity rules:
- `rel = 0` (active step): `op = 1`, radius = `ACT_R = 10`
- `rel > 0` (future steps): `op = 0.38` for ±2, `0.15` for ±3, `0` beyond — fading to
  give a sense of depth and distance
- `rel < 0` (past steps): `op = 0.2` — visibly dimmed to signal "done but not the focus"

### 2. Left decorative nodes — `leftRefs` (4 circles, `left[]`)
Four extra circles that represent **virtual step indices −4, −3, −2, −1** — positions on
the arc that extend *before* step 0 of the pipeline. They are purely decorative: they have
no corresponding pipeline step and carry no label. Their purpose is to make the arc feel
continuous and populated on the left side, balancing the future steps visible on the right.

In pipeline mode they are positioned by `leftPipePositions(sFloat)`:
```
angle = (-90 + (absIdx - sFloat) × 7°)   where absIdx ∈ {−4, −3, −2, −1}
```
Because `absIdx` is fixed and `sFloat` advances, these dots rotate with the arc exactly
like the real pipeline nodes — they are not fixed to screen coordinates. `op = 0.2`
throughout pipeline mode.

### 3. Logo group — `logoGroupRef` (SVG `<g>`)
The original logo SVG circles (center dot + halo + 9 satellites). This group is visible in
logo mode (`logoOp = 1`) and snaps to invisible (`logoOp = 0`) the moment a logo→pipeline
transition begins. The nine satellite positions are the *start/end points* for the
animation (see below).

---

## Logo ↔ Pipeline Animation

All animation runs in a `requestAnimationFrame` loop with no CSS transitions. The
interpolatable state is captured in a single `S` snapshot object (node positions,
arc geometry, halo, opacities). `apply(s: S)` writes everything to the DOM via
`setAttribute` in a single pass.

### Logo → Pipeline (`buildLogoToPipelineFrom`)
The logo group snaps to `logoOp = 0` on the very first frame (seamless visual swap).
Simultaneously, the pipeline node circles and left decorative circles are teleported to
exactly the logo satellite positions with matching opacities — so the viewer sees no jump.
From there each circle animates to its pipeline arc position:

- Logo center dot → active step node (step `s`)
- Logo k=+1…+4 right satellites → pipeline steps `s+1`…`s+4`
- Logo k=−1…−4 left satellites → left decorative arc positions (`leftPipePositions(s)`)

Any pipeline steps beyond `s+4` that don't map to a logo dot are parked off-screen at
`cx = 2000` and are invisible throughout.

### Pipeline → Logo (`buildPipelineToLogoTarget`)
The exact reverse. The left decorative circles and the five mapped pipeline nodes animate
back to their logo satellite positions, brightening from `0.2 → 0.85`. `logoOp` stays `0`
throughout the animation. At the final frame, `snapRef` fires: the logo `<g>` snaps to
`logoOp = 1` in the same RAF frame that the circles arrive at their logo positions —
another seamless swap.

### Step-to-step advance (`lerpPipelineAlongArc`)
When the active step changes within pipeline mode, nodes travel along the `R_CIRC` arc
rather than cutting straight across (which would look like teleporting through the centre
of the circle). The floating step value `sFloat` interpolates from `s0` to `s1`; each
node's angle is recomputed each frame as `(-90 + (i - sFloat) × 7°)`. The left decorative
nodes use `(-90 + (absIdx - sFloat) × 7°)` with the same `sFloat`, so they rotate in
perfect lockstep with the pipeline nodes.

---

## Key Constants

| Constant | Value | Meaning |
|---|---|---|
| `ACTIVE_X` | 400 | X centre of the pipeline arc / active node |
| `NODE_Y` | 38 | Y of the active (topmost) node |
| `R_CIRC` | 1066 | Radius of the node arc circle |
| `CY` | 1104 | Y centre of the node arc circle (`NODE_Y + R_CIRC`) |
| `ANGLE_DEG` | 7 | Degrees between adjacent pipeline nodes |
| `ACT_R` | 10 | Radius of the active node circle |
| `DOT_R` | 7 | Radius of standard pipeline nodes |
| `SAT_R` | 6.5 | Radius of logo satellites / left decorative nodes |
| `PIPE_HR` | 18 | Halo ring radius in pipeline mode |
| `MODE_MS` | 700 | Logo ↔ pipeline transition duration (ms) |
| `STEP_MS` | 580 | Step-to-step advance duration (ms) |

---

## What Not To Change Without Care

- **`R_CIRC` and `ANGLE_DEG`**: changing either shifts every node position and breaks the
  logo satellite → pipeline node correspondence. Both `LOGO_NODES` and `LEFT_SHOW` are
  hand-tuned to match the arc geometry at these exact values.
- **`LOGO_NODES` and `LEFT_SHOW` positions**: these are computed from the original SVG
  geometry (scale 0.55, centred at 480). If the logo SVG changes, all satellite positions
  must be recomputed. The formula is `comp_x = anchor + 0.55 × (svg_x − 121.052)`,
  `comp_y = 38 + 0.55 × (svg_y − 87.969)`.
- **`logoOp` in builder functions**: must be `0` in both the FROM state
  (`buildLogoToPipelineFrom`) and the TO state (`buildPipelineToLogoTarget`). The logo
  group's visibility is managed entirely by `snapRef` — never by the lerp.
- **Left decorative node count (4)**: tied to the four k=±3/±4 logo satellite pairs added
  to the logo SVG `<g>`. Adding or removing satellites requires updating `LEFT_SHOW`,
  `LEFT_SHOW_L`, `leftRefs` size, the JSX circle count, and `leftPipePositions`.
