// Where the nine fields sit on the shell, and which key strikes each.
//
// This is the one piece of geometry the page and the browser both need — Astro
// stamps it into each button's custom properties at build time, and the key map
// is read again at runtime — so it lives in a module with no DOM in it and is
// imported from both sides. A field's place and its key can then never drift
// apart from each other or from the note.
//
// The arrangement is the real one. A handpan has the ding in the middle and the
// eight tone fields around it, ascending in a zigzag: the lowest note low on
// the left, the next low on the right, the next up the left, and so on to the
// top. That is not styling. It is why a handpan can be played at speed — the
// scale runs under alternating hands, and every step is a step across the pan
// rather than along it.

/** A field's place on the shell. All values are percentages of the shell. */
export interface Placement {
  /** Centre, from the left edge of the shell. */
  x: number;
  /** Centre, from the top edge of the shell. */
  y: number;
  /** Diameter. */
  size: number;
}

/** How far the eight tone fields sit from the centre of the shell. */
const RING_RADIUS = 33;

/** Half a step, so the ring is symmetrical about the vertical axis and the two
 *  lowest fields straddle the near edge where the hands rest. */
const FIRST_ANGLE = 22.5;

/** Eight fields evenly around the ding. */
const ANGLE_STEP = 45;

/** The ding is the biggest area of steel on the pan, and the lowest note. */
const DING_SIZE = 28;

/** Diameter of the lowest tone field, and how much each next one loses.
 *  Lower notes need more steel, so a real pan's fields shrink as they climb —
 *  which also makes the ascent legible before a single note is struck. */
const LARGEST_FIELD = 22.5;
const SHRINK_PER_FIELD = 0.95;

/**
 * Where field `index` sits. Index 0 is the ding, at the centre; 1..8 climb the
 * scale, odd on the left of the pan and even on the right.
 */
export function placement(index: number): Placement {
  if (index <= 0) return { x: 50, y: 50, size: DING_SIZE };

  // Two fields per rung of the climb: 1 and 2 are the lowest pair, 7 and 8 the
  // highest. Odd indices take the left half of the pan, even the right.
  const rung = Math.floor((index - 1) / 2);
  const fromNear = FIRST_ANGLE + rung * ANGLE_STEP;
  const onLeft = index % 2 === 1;

  // Degrees clockwise from twelve o'clock. 180 is the near edge of the pan,
  // closest to the player, so the climb runs outward from there up both sides.
  const degrees = onLeft ? 180 + fromNear : 180 - fromNear;
  const radians = (degrees * Math.PI) / 180;

  return {
    x: 50 + RING_RADIUS * Math.sin(radians),
    y: 50 - RING_RADIUS * Math.cos(radians),
    size: LARGEST_FIELD - (index - 1) * SHRINK_PER_FIELD,
  };
}

/**
 * How much of the light this field's patch of shell is turned toward, 0..1.
 *
 * The shell is a dome and the light is up and to the left, so a field low on
 * the right sits on steel that has already rolled away from the light and a
 * field high on the left sits on steel facing straight into it. Without this
 * every crater is lit identically and the nine of them read as holes punched
 * in a flat plate — the shading of each dent has to agree with the shading of
 * the surface it was pressed into.
 */
export function litness(index: number): number {
  const { x, y } = placement(index);
  const dx = (x - 50) / 50;
  const dy = (y - 50) / 50;
  // How far this direction points back toward the light, which comes from
  // (-1, -1): 1 straight at it, -1 straight away.
  const toward = (-dx - dy) / Math.SQRT2;
  return 0.5 + 0.5 * Math.max(-1, Math.min(1, toward));
}

/**
 * The key that strikes each field, indexed the same way the fields are.
 *
 * Chosen so the keyboard is laid out like the pan rather than like the
 * alphabet: each hand takes one side, and each side climbs its own column of
 * keys as the notes climb the shell. Running the scale is `v n f j r u 4 7`,
 * which alternates hands exactly as playing the real thing does.
 *
 * Every field is still a real <button>, so Tab and Enter reach all nine
 * without knowing any of this; the map is what turns tabbing into playing.
 */
export const FIELD_KEYS: readonly string[] = ["b", "v", "n", "f", "j", "r", "u", "4", "7"];

/** The field a key strikes, or -1. Case-folded, so shift does not break it. */
export function fieldForKey(key: string): number {
  return FIELD_KEYS.indexOf(key.toLowerCase());
}
