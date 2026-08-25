import type { Field, Handpan } from "./types";

// Sprint 4: the instrument answers you.
//
// A rolling log of recent strikes; a phrase boundary is a pause after three or
// more of them; the answer is that same phrase played back quieter, delayed,
// shifted to a harmonically related field, and repeated a few times with each
// repeat fainter than the last until it falls silent on its own.
//
// No record button, no mode, no visible state anywhere. The only interface
// this exposes is `tick`, polled with the current audio-clock time exactly the
// way `ui/glow.ts` polls `amplitudeAt` every frame. That is what makes this
// testable through an OfflineAudioContext: a test can call `tick` at exact,
// chosen instants instead of racing a real `setTimeout` against wall-clock
// time, which has no fixed relationship to an offline render's audio clock at
// all (time there only moves inside a `suspend()` callback). It is also, in a
// real browser, at least as accurate as a timer: driven from
// `requestAnimationFrame`, its jitter is one frame (~16ms at 60Hz) rather than
// the 4-15ms (worse under load) a `setTimeout` carries — and it never drifts
// out of step with the clock the strikes themselves are stamped on, because it
// polls that same clock directly instead of guessing elapsed wall time.
//
// DOM-free and built only against the `Handpan` contract, exactly like
// resonance.ts — this module never needed `Handpan.strike()`'s `when` to gain
// a future timestamp; `engine.ts` and `types.ts` are untouched.

/** A phrase needs at least this many strikes before a pause counts as the end
 *  of one — one or two taps is just playing, not a phrase to answer. */
const MIN_PHRASE_STRIKES = 3;

/** How long a gap has to be before it reads as "the player stopped," in
 *  seconds. */
const PAUSE_S = 0.8;

/** Strikes older than this many-back are no longer "the phrase just played" —
 *  bounds a rolling log so an uninterrupted playing session with no pause
 *  cannot grow it without limit. */
const MAX_LOG_STRIKES = 24;

/** Silence before the first repeat begins, on top of the pause that already
 *  triggered it — long enough to read as a considered reply rather than an
 *  instant echo, short enough that the whole exchange still lands inside the
 *  ten seconds a stranger is meant to discover this in. */
const ANSWER_DELAY_S = 1.1;

/** The answer opens at roughly a third of the phrase's own velocity — inside
 *  the brief's 30-40% band, quiet enough to sit behind the player rather than
 *  beside them. */
const ANSWER_GAIN = 0.35;

/** Each repeat is this fraction of the loudness of the one before it. */
const REPEAT_DECAY = 0.5;

/** Below this a repeat would be inaudible against the room anyway, so
 *  scheduling it would only be waiting out silence that nobody hears. */
const GAIN_FLOOR = 0.05;

/** Hard ceiling on repeats regardless of the gain arithmetic above — the
 *  guarantee that this stops does not depend on floating point behaving. */
const MAX_REPEATS = 4;

/** Breath between the end of one repeat's phrase and the start of the next. */
const REPEAT_GAP_S = 0.6;

/** A memory strike always lands dead centre: it is the shell answering, not a
 *  hand, so it is fundamental-heavy and soft — the same convention
 *  resonance.ts uses for a sympathetically excited neighbour. */
const MEMORY_POSITION = 0;

/**
 * Ratios that read as "the same idea, not the same note": the octave and the
 * fifth, up or down. A handpan's own compound-fifth partial (MODE_RATIOS in
 * types.ts) already primes the ear for exactly this relationship, which is
 * why the answer reaches for it instead of picking an arbitrary neighbour.
 */
const RELATION_RATIOS = [2, 0.5, 1.5, 2 / 3];

/**
 * How close a candidate has to land to one of RELATION_RATIOS, in octaves,
 * before the relationship counts as real rather than coincidence. A twelfth
 * of an octave is half a semitone, generous enough for a nine-note scale that
 * skips most of these intervals outright.
 */
const RELATION_TOLERANCE_OCTAVES = 1 / 12;

/**
 * For each field, the one other field that best matches a simple ratio to it
 * (octave or fifth, either direction), computed once from the pan's fixed
 * fundamentals. Falls back to the field itself if nothing on the pan comes
 * close enough — repeating the same note quietly is more honest than
 * shifting to something that is not actually related.
 */
function buildRelations(fields: readonly Field[]): ReadonlyMap<number, number> {
  const relations = new Map<number, number>();
  for (const origin of fields) {
    let best = origin.index;
    let bestError = Infinity;
    for (const ratio of RELATION_RATIOS) {
      const target = origin.frequency * ratio;
      for (const candidate of fields) {
        if (candidate.index === origin.index) continue;
        const error = Math.abs(Math.log2(candidate.frequency / target));
        if (error < bestError) {
          bestError = error;
          best = candidate.index;
        }
      }
    }
    relations.set(origin.index, bestError < RELATION_TOLERANCE_OCTAVES ? best : origin.index);
  }
  return relations;
}

interface LoggedStrike {
  index: number;
  when: number;
  velocity: number;
}

interface ScheduledStrike {
  when: number;
  index: number;
  velocity: number;
}

export interface Memory {
  /** Poll with the current audio-clock time. Call every animation frame in
   *  the browser; a test can call it at exact, chosen instants instead. */
  tick(when: number): void;
  /** Stop listening and drop anything still queued. */
  detach(): void;
}

/**
 * Wire phrase memory onto an already-built `Handpan`.
 *
 * The critical safety property: a strike this module makes — or anything a
 * memory strike excites sympathetically through resonance.ts — must never be
 * logged as the player's own playing, or the instrument would answer its own
 * answer, and that answer's answer, forever.
 *
 * A WeakSet keyed on the strike object, the way resonance.ts recognises its
 * own strikes, catches the direct case but not this one: resonance.ts reacts
 * to *every* strike it sees, including this module's, by calling
 * `pan.strike()` on a neighbour with a *new* Strike object of its own — one
 * this module never created and so could never recognise by reference alone.
 * Left unguarded, a memory strike's own sympathetic ring would be logged as a
 * fresh player strike, and enough of those over a few repeats reach
 * MIN_PHRASE_STRIKES on their own, which would make the shell answer an
 * answer that was never played.
 *
 * What actually closes this is `echoing`: JavaScript is single-threaded, so
 * every observer notification a memory strike triggers — including whatever
 * resonance.ts excites synchronously in response to it — happens nested
 * inside the very call to `pan.strike()` that made it, before that call can
 * return. Holding a flag for the duration of that one call catches the direct
 * strike and everything it echoes, regardless of how many other modules are
 * listening or what they do in response.
 */
export function attachMemory(pan: Handpan): Memory {
  const relations = buildRelations(pan.fields);

  let log: LoggedStrike[] = [];
  let answered = false;
  let queue: ScheduledStrike[] | null = null;
  let next = 0;
  let echoing = false;

  const unsubscribe = pan.onStrike(({ index, strike, when }) => {
    if (echoing) return;

    // A real strike always takes priority: drop anything still queued rather
    // than let the memory talk over the player it is meant to sit behind.
    queue = null;
    next = 0;

    // Two or more notifications landing at the exact same instant are one
    // physical strike and its own sympathetic resonance (resonance.ts, or
    // anything else reacting synchronously to a strike), not a second thing
    // the player did: no audio-clock time passes between synchronous calls,
    // so a genuine next strike — however fast the tapping — always lands at
    // a `when` a real tick later. Logging only the first notification at a
    // given instant is what keeps the captured phrase the size of what was
    // actually played, rather than growing with however many neighbours each
    // note happens to excite; left unguarded, a 3-note phrase struck on a
    // shell with several harmonically related fields becomes an answer with
    // three times that many notes, and the "quieter, further behind" the
    // brief asks for stops being true.
    if (log.length > 0 && log[log.length - 1].when === when) return;

    if (answered) {
      log = [];
      answered = false;
    }

    log.push({ index, when, velocity: strike.velocity });
    if (log.length > MAX_LOG_STRIKES) log.shift();
  });

  /** Flatten a captured phrase into an absolute-time schedule: MAX_REPEATS
   *  passes at most, each quieter than the last, stopping the moment the
   *  gain would fall below what is worth hearing. */
  function buildAnswer(entries: readonly LoggedStrike[], now: number): ScheduledStrike[] {
    const phraseStart = entries[0].when;
    const duration = entries[entries.length - 1].when - phraseStart;

    const events: ScheduledStrike[] = [];
    let gain = ANSWER_GAIN;
    let start = now + ANSWER_DELAY_S;
    for (let repeat = 0; repeat < MAX_REPEATS && gain >= GAIN_FLOOR; repeat += 1) {
      for (const entry of entries) {
        events.push({
          when: start + (entry.when - phraseStart),
          index: relations.get(entry.index) ?? entry.index,
          velocity: Math.max(0, Math.min(1, entry.velocity * gain)),
        });
      }
      start += duration + REPEAT_GAP_S;
      gain *= REPEAT_DECAY;
    }
    return events;
  }

  return {
    tick(when: number): void {
      if (queue) {
        while (next < queue.length && queue[next].when <= when) {
          const event = queue[next];
          echoing = true;
          try {
            pan.strike(event.index, { velocity: event.velocity, position: MEMORY_POSITION });
          } finally {
            echoing = false;
          }
          next += 1;
        }
        if (next >= queue.length) {
          queue = null;
          next = 0;
        }
        return; // never start a second answer while one is still playing out
      }

      if (answered || log.length < MIN_PHRASE_STRIKES) return;
      const last = log[log.length - 1];
      if (when - last.when < PAUSE_S) return;

      queue = buildAnswer(log, when);
      next = 0;
      answered = true;
    },

    detach(): void {
      unsubscribe();
      queue = null;
    },
  };
}
