// The transient. The glow carries the note's whole decay; this carries the
// instant of contact — a shockwave leaving the exact point the hand landed,
// gone in under a second.
//
// It is deliberately the one visual that is *not* envelope-driven: the strike
// itself is shorter than a frame, so there is nothing in the envelope to read.
// Its size and brightness come from the strike's velocity, so a soft tap
// ripples faintly and a hard one snaps.

const BASE_MS = 620;

let reducedMotion: MediaQueryList | null = null;

function prefersReducedMotion(): boolean {
  reducedMotion ??= window.matchMedia("(prefers-reduced-motion: reduce)");
  return reducedMotion.matches;
}

/**
 * Emit a shockwave inside `host`, centred on the point that was struck.
 *
 * `x` and `y` are fractions of the host's box (0..1); velocity is the strike's.
 * Silently does nothing when the player has asked for reduced motion — the
 * amplitude glow still reports the strike, so no feedback is lost.
 */
export function ripple(host: HTMLElement, x: number, y: number, velocity: number): void {
  if (prefersReducedMotion()) return;

  const wave = document.createElement("span");
  wave.className = "ripple";
  wave.setAttribute("aria-hidden", "true");
  wave.style.left = `${(x * 100).toFixed(2)}%`;
  wave.style.top = `${(y * 100).toFixed(2)}%`;
  host.append(wave);

  const spread = 1.4 + velocity * 1.9;
  const animation = wave.animate(
    [
      { transform: "translate(-50%, -50%) scale(0.12)", opacity: 0.1 + velocity * 0.65 },
      { transform: `translate(-50%, -50%) scale(${spread.toFixed(2)})`, opacity: 0 },
    ],
    {
      duration: BASE_MS + velocity * 260,
      easing: "cubic-bezier(0.16, 0.9, 0.3, 1)",
      fill: "forwards",
    },
  );

  const remove = (): void => {
    wave.remove();
  };
  animation.addEventListener("finish", remove);
  animation.addEventListener("cancel", remove);
}
