# COMP4020 prototype

Your starter repo for a COMP4020 prototype: a static site in HTML/CSS/TypeScript
that builds to plain HTML/CSS/JS and deploys to GitHub Pages. The deployed site
is what gets marked, not this repo.

The
[course website](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/)
publishes this deliverable's brief and spec, and this repo's name tells you
which deliverable applies. Read both before you plan or build.

## How to work in here

- Keep the dev server running (`pnpm dev`) so you see changes as you make them.
- Run `pnpm check` before you push.
- Open the page in a browser and look at it. The rendered page is the truth;
  your mental model of it isn't.
- When a check fails, read its output before you change anything.
- Never commit a red state.

## The link-preview card

`public/card.png` (1200x630) is the image a shared link shows; on this Astro
build the head lives in `src/layouts/Layout.astro` (`description` and `card`
props), not `index.html`. Replace the image and pass a real `description` from
each page. The card URL resolves against the page that names it, like any link
--- nothing in CI checks it, so look at the deployed head when you add pages.

## The checks

`pnpm check` runs them (`pnpm check:evidence` is the extra gate before you
ship); CI runs the same plus links, secrets and the deploy. Read the failure.

`spec/README.md`, `PROCESS.md` and `reflections/README.md` are in this repo and
say what they are for.

## This file is yours

A starting point, not a rulebook. As you learn what your prototype needs --- a
convention the work has to hold to, a sensor that keeps catching you out (a
linter, say), a fact about the stack that is easy to get wrong --- write it down
here and wire it into `check`. Growing this file is the work.

## What earlier builds taught the harness

Rules earned the hard way on past prototypes. Hold agents (and yourself) to them.

### Assignment 1

- **The spec suite runs against static `dist/` HTML (JSDOM) — it cannot see
  interaction, audio, layout, or overflow.** A green `pnpm check` proved the
  hooks exist while the phone layout was still broken and a control was burying
  a song. Anything the visitor *does* (click, tap, play) or *sees at a
  viewport* must be verified by driving the built site in a real browser, not
  by the suite alone (headless Chromium against `pnpm preview`, served under
  the repo's real base path).
- **A subagent reporting "pnpm check green" is necessary, not sufficient.**
  Re-verify its work independently before committing: screenshot both marked
  viewports (390×844 and 1920×1080) and assert
  `document.documentElement.scrollWidth <= window.innerWidth` (no horizontal
  overflow), and drive the actual interaction. Trust the artefact you looked
  at, not the report.
- **Astro base path bites only on the live URL.** Assets 404 on
  `…github.io/<repo>/` if `base` is wrong while looking fine locally --- always
  verify against `pnpm preview` (which serves under the base), not `pnpm dev`
  at root.
- **Commit one verified phase at a time.** Each phase committed only after its
  own verification passed. The history is then an honest record of how it came
  together, which is itself marked.
