// The gesture that makes damping discoverable without a word of instruction.
//
// A strike is a tap: press, sound, release, all inside a beat — measured
// strike-and-lift in this project has been well under 150ms. Resting a palm
// on ringing steel is a different physical action: the hand does not lift.
// So the two are told apart the same way a real hand would tell them apart —
// by whether the press is still down a beat later — rather than by any
// separate control. A press that lifts early was always just a strike,
// however long it lasted; the sound has already played the instant the press
// began, so there is nothing to get "wrong" by lifting sooner or later.
//
// One damper instance serves pointer, touch and keyboard alike. Each caller
// hands it a "session" id standing for one continuous press — a pointerId
// for pointer/touch, a key code for the keyboard — and the damper does not
// care which input produced it.

/** How long a press has to stay down, untouched, before it reads as a palm
 *  laid on the field rather than a strike that simply hasn't lifted yet.
 *  Comfortably longer than any strike-and-lift made while actually playing,
 *  short enough that a deliberate hold answers within a beat. */
export const DAMP_HOLD_MS = 280;

export interface HoldDamper {
  /** A press landed on `index`. (Re)starts the countdown to a damp for this
   *  session. Calling it again for the same session — a rake moving to a new
   *  field, say — cancels whatever was counting down before. */
  press(session: string | number, index: number): void;
  /** The press ended, or moved off the field it was holding. Safe to call on
   *  a session that was never pressed, or one that already fired. */
  release(session: string | number): void;
}

/**
 * `onDamp` fires at most once per `press()` call, and only if `release()` is
 * not called first for that same session.
 */
export function createHoldDamper(onDamp: (index: number) => void): HoldDamper {
  const timers = new Map<string | number, ReturnType<typeof setTimeout>>();

  const release = (session: string | number): void => {
    const timer = timers.get(session);
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(session);
  };

  return {
    press(session, index): void {
      release(session);
      timers.set(
        session,
        setTimeout(() => {
          timers.delete(session);
          onDamp(index);
        }, DAMP_HOLD_MS),
      );
    },
    release,
  };
}
