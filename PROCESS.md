# Process overview

A reading-guide to how this prototype came together: the moments that mattered,
each pointing at the commit that holds it.

## What I built

A handpan --- a steel percussion instrument with a central ding and eight tone
fields tuned to a single scale --- synthesised live in the browser with Web
Audio. Sprint 0 built one field to modal-synthesis quality (fundamental, tuned
octave and compound fifth aligned for the "singing" quality, plus inharmonic
shimmer partials) as a real, server-rendered `<button>`, verified against an
`OfflineAudioContext` test suite and driven in a real browser at both marked
viewports. The idea and the sprint plan for the rest of the instrument are in
[`PLAN.md`](PLAN.md); this is a prototype in progress, not the finished piece.

## The moments that mattered

1. **The contract came before the code.** Before any sprint work started,
   `src/scripts/audio/types.ts` and `scales.ts` fixed the interface between the
   audio engine, the input layer and the renderer --- DOM-free and built against
   `BaseAudioContext` so the same engine can later render through an
   `OfflineAudioContext` under test. That let sprint 0's engine, test suite and
   page be written against one fixed shape instead of each inventing its own
   ([`076add1`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit4-HarkiratS1511/commit/076add11e10b62ba3d59f9109ac0ee951031d059)).
   The published spec's checkable lines were turned into tests the same session,
   before any prototype existed, so `spec/crit-4.test.ts` started red
   ([`2a173ba`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit4-HarkiratS1511/commit/2a173ba321cb83d610fe073e117f9a4980707428)).

2. **A real bug in the persistent-oscillator architecture, caught by measurement
   before it reached a listener.** `PLAN.md` commits to oscillators that start
   once and never stop, so a detuned pair for chorus on the low modes locks its
   phase to context time zero rather than to the strike --- it passes through a
   full null every `1/split` seconds, and a strike landing near one lost its
   fundamental (measured 0.155 to 0.010 at t=0.75s). The fix was to move the
   detuning off the fundamental modes entirely and keep it only on the shimmer
   partials, where a null reads as movement rather than as a dead note
   ([`d4ba5ad`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit4-HarkiratS1511/commit/d4ba5ad58b9694d8054903e65d01cc311cb1d290)).

3. **Choosing the offline audio library on evidence, not convenience.**
   `node-web-audio-api` was the obvious pick for rendering audio headlessly
   under vitest, but its native binary requires `libasound.so.2` even for
   offline rendering, which CI doesn't have. `web-audio-engine` was
   cross-validated against it first (max sample delta 1.3e-3) before being
   adopted as the test-suite renderer, so the sound itself is under test rather
   than only the markup
   ([`d4ba5ad`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit4-HarkiratS1511/commit/d4ba5ad58b9694d8054903e65d01cc311cb1d290)).
   The suite's assertions were mutation-checked rather than trusted on sight ---
   a naive sine beep misses the partial-ratio bar by ~800x, and a "position"
   control that only changes gain fails all three mix tests --- and that check
   also found one assertion that wasn't load-bearing: a finite-samples check
   meant to catch a NaN turns out to be belt-and-braces only, because
   `web-audio-engine` coerces a NaN written to an `AudioParam` to zero before it
   can reach the output, so it's commented as such rather than left to imply a
   guarantee the test doesn't actually provide
   (`spec/audio.test.ts:889-905`).

4. **Two bugs only a real browser could show up, caught by driving the built
   site instead of trusting the offline suite.** The glow slept through the
   first note because `AudioContext.currentTime` is pinned at 0 until the audio
   thread renders a block, which the JSDOM/offline suite can't reproduce; and
   touch couldn't start audio at all, because Chrome grants user activation on
   `touchend` rather than `touchstart`, so the first tap was silently lost. Both
   were only visible driving `pnpm preview` under the real Pages base path in
   Chromium, which is the check `CLAUDE.md`'s Assignment 1 lessons already
   required carrying forward
   ([`d4ba5ad`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit4-HarkiratS1511/commit/d4ba5ad58b9694d8054903e65d01cc311cb1d290)).

5. **The harness itself was edited, not just the code.** Rather than starting
   `CLAUDE.md` from the template, the earned section from the Assignment 1 repo
   ("What earlier builds taught the harness") was carried forward, dropping the
   two bullets specific to that assignment's chord app and keeping the general
   lessons --- the static-suite-can't-see-interaction rule, the
   subagent-report-isn't-verification rule, the Astro base-path rule, and
   commit-one-verified-phase-at-a-time --- which is why the browser-only bugs in
   moment 4 were caught at all
   ([`452d5e3`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit4-HarkiratS1511/commit/452d5e34507d4c1da56b1bf185403bfd9d922e77)).

## Before you ship

This is sprint 0 of the plan in `PLAN.md`: one field built to full quality, not
the whole instrument. Later sprints (the nine-field layout, expressiveness,
sympathetic resonance, the memory that answers back, the gliding scale) are
still to come and will add to this file as they land.
