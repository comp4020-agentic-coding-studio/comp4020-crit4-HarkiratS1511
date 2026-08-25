import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

// crit 4 "An instrument" (https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/crits/04-instrument/):
// the mechanically-checkable lines of the published spec. Most of the spec —
// expressiveness, whether a stranger can pick it up uninstructed, whether it's
// any good — only a person can judge; that's left to the crit, not asserted
// here. These run against the BUILT site (dist/), same as the invariants.
const DIST = resolve("dist");

function files(dir: string = DIST): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

const pages = files()
  .map((path) => relative(DIST, path).split(sep).join("/"))
  .filter((name) => name.endsWith(".html"))
  .map((name) => ({
    name,
    doc: new JSDOM(readFileSync(join(DIST, name), "utf8")).window.document,
  }));

const FAIL_STATE_WORDS = /\b(score|game\s*over|you\s*(lose|win)|lives\s*left|fail(ed)?)\b/i;

describe("crit 4: an instrument", () => {
  for (const { name, doc } of pages) {
    describe(name, () => {
      it("makes sound live rather than playing it back", () => {
        expect(
          doc.querySelectorAll("audio").length,
          "the brief asks for sound made live in the page by the player, not a recording played back — an <audio> element is a sign this shipped a playback widget instead of an instrument",
        ).toBe(0);
      });

      it("ships at least one keyboard-focusable control for making sound", () => {
        const focusable = [...doc.querySelectorAll("button, [tabindex]")].filter(
          (el) => el.getAttribute("tabindex") !== "-1",
        );
        expect(
          focusable.length,
          "playable with whatever is at hand includes a keyboard — a real <button> or a tabindex-reachable element is what makes that possible, a bare <div onclick> is not",
        ).toBeGreaterThan(0);
      });

      it("has no score or fail-state UI", () => {
        const text = doc.body?.textContent ?? "";
        expect(
          FAIL_STATE_WORDS.test(text),
          "there is no way to play it wrong — no score, no fail state, so none of that vocabulary should ship on the page",
        ).toBe(false);
      });
    });
  }
});
