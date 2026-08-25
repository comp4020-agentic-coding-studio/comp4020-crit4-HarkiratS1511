# Build plan — a handpan that is alive

The deliverable is [crit 4, "An instrument"](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/crits/04-instrument/).
This file records how I decided to answer it and in what order I intend to
build. It is a plan, not a spec: the spec is published on the course site and is
the fixed contract.

## The idea

A handpan — a steel percussion instrument with a central "ding" and eight tone
fields tuned to a single scale — synthesised live in the browser with Web Audio.

A handpan is chosen because two of its properties are already the spec's:

- **there is no way to play it wrong.** A handpan is tuned to one scale, so
  every field sounds good against every other. That isn't a constraint imposed
  to satisfy the brief; it is what the instrument is.
- **a stranger can play it uninstructed.** Visible tone fields read as "tap me".
  No hint animation, no opening instructions.

Each field is a real `<button>`, which makes the keyboard and screen-reader
story structural rather than a retrofit.

## Why it isn't a skeuomorph

The risk in modelling an acoustic instrument is copying its limitations along
with its sound. The ambition here comes from inverting things steel cannot do:

- **the resonance is visible.** Striking one field sympathetically excites its
  harmonic neighbours — real handpan physics that happens invisibly inside the
  shell. Here the glow is driven by the same envelope state that drives the
  gain, so the visual is not a representation of the sound, it is the sound's
  state rendered a second way.
- **the instrument answers you.** The shell has a memory. Play a phrase, stop,
  and it comes back quieter a moment later, shifted to a harmonically related
  field, fading over repeats. Not a loop pedal — no record button, no mode. A
  stranger discovers it within ten seconds of their first tap.
- **the scale glides while notes are ringing.** A physical handpan is one scale,
  hammered permanently into the steel; a second scale means a second instrument.
  Here the fields drift continuously from D Kurd toward another mode *mid
  sustain*, so a ringing F natural slides up to F# under your hands. This is not
  a feature steel lacks — it is a musical event steel cannot produce.
- **it plays in.** Real handpans "open up" over months of playing. Fields struck
  often grow richer partials and longer decay, so the instrument becomes the
  player's in a way that is literally true.

## Architecture decisions

Made before any sprint, because they are cheap now and expensive later.

1. **Persistent oscillators.** Nine fields x ~5 modes, started once at gain 0 and
   never stopped. Voice allocation stops being a problem, retriggering a ringing
   field re-excites it (which is what steel does), and scale morphing becomes a
   frequency ramp on an already-running oscillator rather than a rebuild.
2. **The audio engine is a pure module with no DOM knowledge.** It is
   constructed against `BaseAudioContext`, not `AudioContext`, so the same code
   renders through an `OfflineAudioContext` in a headless test. This is how the
   sound itself gets under test — the JSDOM spec suite cannot hear anything.
3. **The envelope is modelled analytically in JS alongside the audio graph.**
   Strike time, peak and decay constant give current amplitude as a formula, so
   visuals read exact values without sampling `AudioParam.value` during
   automation.
4. **A limiter on the master bus from the first commit.** Long decays plus fast
   tapping plus sympathetic resonance will pile up.

## Sprints

Every sprint ends in a deployable, checks-green state. Stopping after any one of
them leaves something a stranger could play. Sprint boundaries are commit
boundaries.

### Sprint 0 — one field, one beautiful note

The sound is the hard part and the layout is easy, so one field is made
excellent before it is multiplied by nine.

AudioContext resumed by the first gesture; the opening screen that is itself the
invitation; one tone field as a real `<button>`; modal synthesis (fundamental,
tuned octave, compound fifth, plus inharmonic partials for steel shimmer); ~5ms
attack ramp; 3-8s decay with higher modes dying faster.

Done when a single tap sounds like struck steel and `spec/crit-4.test.ts`'s
focusable-control assertion is green.

### Sprint 1 — the instrument

Nine fields in D Kurd, laid out in the authentic pattern that ascends
alternating left and right around the ding so scales can be run with alternating
hands. Responsive circular geometry at both marked viewports. Keyboard mapping,
pointer, touch, multi-touch.

Done when it is a playable handpan on desktop and phone. **Ship checkpoint** —
the minimum credible artefact.

### Sprint 2 — expressiveness

The sprint that keeps nine fixed pitches from being a xylophone, and the
difference between satisfying the spec and appearing to.

Strike position within a field (centre fundamental-heavy, edge overtone-rich)
driving partial mix; velocity from pointer speed before contact, *not*
`PointerEvent.pressure`, which returns a flat 0.5 for mouse; damping on held
press.

Done when the same nine notes played soft and hard sound like different
instruments. **Ship checkpoint** — every published spec line honestly satisfied.

### Sprint 3 — resonance, audible and visible

Harmonic affinity between fields (closeness of `fj/fi` to simple ratios); each
strike excites related fields at 5-15% gain; glow driven by the analytic
envelope.

Done when the instrument stops sounding like nine separate bells.

### Sprint 4 — the instrument answers you

A rolling log of strikes; phrase-boundary detection on a gap after three or more
strikes; delayed, quieter replay shifted to a harmonically related field, fading
over repeats.

Constraints that decide whether it is a duet or a gimmick: one memory voice at a
time, low gain, softer timbre so it sits behind the player, ducking when the
player strikes.

### Sprint 5 — the scale glides

Scales as semitone offsets; log-space interpolation; a single continuous control
(an arc around the pan, never a dropdown or anything resembling a settings
panel).

Done when a chord can be struck and the scale morphed while it is still ringing.

### Sprint 6 — playing it in

Per-field play counts enriching inharmonic content and lengthening decay, with a
visible patina.

Honest assessment: in a three-minute cold-open crit nobody notices this unless
the visual sells it. Placed last deliberately; first to cut.

## Verification

A green `pnpm check` proves the hooks exist, not that the instrument sounds or
feels like anything. Per sprint:

- `pnpm check` green
- the `OfflineAudioContext` suite green — the sound is present and shaped right
- driven in a real browser at 390x844 and 1920x844 against `pnpm preview` under
  the `/comp4020-crit4-HarkiratS1511/` base path, not `pnpm dev` at root
- `scrollWidth <= innerWidth` at both viewports
- **listened to.** The sensor none of the above replaces, and the one the crit
  actually uses.

## If it has to be cut

Cut from the bottom: sprint 6, then 5, then 4. Sprints 0-2 are non-negotiable —
0 and 1 make it an instrument, 2 is what makes it meet the spec rather than
appear to. Leave room for `PROCESS.md` and `reflections/crit-4.md`; the
reflection at the cutoff decides whether the week counts as shipped at all.
