import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { D_KURD, fieldsFor } from "../src/scripts/audio/scales";

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

// The nine tone fields of the pan. `data-field` is the contract between the
// markup and the audio engine — it is the index a tap is routed by — so it is
// the one hook these tests are allowed to know about. Everything else here
// (class names, custom properties, how the buttons are nested, whether the
// layout is a grid or absolute positioning) is deliberately not asserted: the
// contract is that nine notes are reachable and correctly named, not how the
// shell is drawn.
const TONE_FIELDS = "[data-field]";

/** What the pan is meant to sound, from the same module the engine tunes
 *  itself from. The point of comparing the two is that the note stamped on the
 *  shell and the note that sounds cannot drift apart. */
const FIELDS = fieldsFor(D_KURD);

/**
 * The name a screen reader would announce for a control.
 *
 * A deliberate subset of the real accessible name computation — aria-label,
 * then aria-labelledby, then the element's own text with `aria-hidden`
 * subtrees dropped. That is enough to cover any reasonable way of naming a
 * tone field without the test caring which one was chosen.
 */
function accessibleName(el: Element): string {
  const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

  const label = el.getAttribute("aria-label");
  if (label && collapse(label)) return collapse(label);

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const referenced = collapse(
      labelledBy
        .split(/\s+/)
        .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? "")
        .join(" "),
    );
    if (referenced) return referenced;
  }

  const visible = el.cloneNode(true) as Element;
  for (const hidden of [...visible.querySelectorAll('[aria-hidden="true"]')]) hidden.remove();
  return collapse(visible.textContent ?? "");
}

/** Whether a control is reachable by tabbing to it. */
function keyboardReachable(el: Element): boolean {
  const tabindex = el.getAttribute("tabindex");
  if (tabindex !== null) return Number.isFinite(Number(tabindex)) && Number(tabindex) >= 0;
  return el.tagName === "BUTTON" || (el.tagName === "A" && el.hasAttribute("href"));
}

/** Every note name mentioned in a string, e.g. "D3" or "A#4". Written as a
 *  scan rather than an equality check so a field may announce itself as "D3"
 *  or "D3, the ding" without the test having an opinion — what it may not do
 *  is announce a note it does not sound. */
function notesIn(text: string): string[] {
  return text.match(/[A-G]#?\d/g) ?? [];
}

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

describe("crit 4: the nine fields of the pan", () => {
  // A D Kurd handpan is a central ding and eight tone fields. These assert
  // that all nine ship, that each one is a control a player can reach with
  // whatever is at hand, and that the note written on a field is the note that
  // field sounds. What they deliberately do not assert is anything about how
  // the instrument is drawn, so that the layout, the styling and the framework
  // can all be rewritten underneath them.
  const home = pages.find(({ name }) => name === "index.html");
  const fields = home ? [...home.doc.querySelectorAll(TONE_FIELDS)] : [];

  it("ships the instrument on the page a visitor lands on", () => {
    expect(
      home,
      "the instrument is the site — a visitor who follows the link must land on it, not on a page about it",
    ).toBeTruthy();
  });

  it("ships all nine fields of the pan, indexed 0 to 8", () => {
    expect(
      fields.length,
      "a D Kurd pan is a central ding and eight tone fields, so nine fields have to ship — anything fewer is a fragment of an instrument and a scale a player cannot finish",
    ).toBe(FIELDS.length);

    const indices = fields.map((el) => Number(el.getAttribute("data-field")));
    expect(
      new Set(indices).size,
      `two fields must never carry the same index, because that index is what routes a tap to a voice — a duplicate means one note of the scale can never be played, and got ${indices.join(", ")}`,
    ).toBe(fields.length);
    expect(
      [...indices].sort((a, b) => a - b),
      "the fields must be indexed 0 through 8 with no gaps, because those indices are the engine's voices and a gap is a button wired to nothing",
    ).toEqual(FIELDS.map((field) => field.index));
  });

  it("makes every tone field a control the keyboard can reach", () => {
    for (const el of fields) {
      const index = el.getAttribute("data-field");
      expect(
        keyboardReachable(el),
        `field ${index} must be a real <button> or a tabindex-reachable element — playable with whatever is at hand includes a keyboard, and a <${el.tagName.toLowerCase()}> that cannot be tabbed to is a note nobody without a mouse can play`,
      ).toBe(true);
      expect(
        el.hasAttribute("disabled"),
        `field ${index} must not ship disabled — every field of a handpan is always available, there is nothing to unlock and no wrong time to strike one`,
      ).toBe(false);
      expect(
        el.getAttribute("aria-hidden"),
        `field ${index} must not be hidden from assistive technology; a field a screen reader cannot see is a note that player does not have`,
      ).not.toBe("true");
    }
  });

  it("gives every tone field a distinct, non-empty accessible name", () => {
    const names = fields.map((el) => accessibleName(el));

    for (const [i, name] of names.entries()) {
      expect(
        name,
        `field ${fields[i].getAttribute("data-field")} must announce itself as something — an unnamed button is read out as "button", which tells a player nothing about what they are about to strike`,
      ).not.toBe("");
    }

    expect(
      new Set(names).size,
      `every field must be distinguishable by name; nine fields announced as ${[...new Set(names)].join(", ") || "nothing"} leave a player unable to tell one note from another`,
    ).toBe(fields.length);
  });

  it("names each field with the note that field actually sounds", () => {
    // The contract this exists for: the note stamped on the shell is derived
    // from the same scale the audio engine is tuned from, so the two cannot
    // drift. A pan labelled in D Kurd but ringing in something else is worse
    // than one with no labels at all.
    const stamped = FIELDS.map((field) => {
      const el = fields.find((candidate) => Number(candidate.getAttribute("data-field")) === field.index);
      return el ? notesIn(accessibleName(el)).join(" ") : "(no such field)";
    });

    expect(
      stamped,
      "each field must announce the note it sounds and no other — these are the nine notes of a D Kurd pan, in the order the fields are indexed, and any difference means a player is being told one note and hearing another",
    ).toEqual(FIELDS.map((field) => field.name));
  });
});
