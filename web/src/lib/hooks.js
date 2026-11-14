import { useCallback, useEffect, useRef, useState } from "react";

const reduced = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * Fires once when the element first scrolls into view. Every component
 * that animates on arrival uses this rather than animating on mount,
 * so nothing plays its entrance off-screen.
 */
export function useInView({ threshold = 0.25, once = true } = {}) {
  const ref = useRef(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduced()) {
      setInView(true);
      return;
    }

    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          if (once) io.disconnect();
        } else if (!once) {
          setInView(false);
        }
      },
      { threshold }
    );

    io.observe(el);
    return () => io.disconnect();
  }, [threshold, once]);

  return [ref, inView];
}

/**
 * Eases a number up to its target on a rAF loop. Returns the live value
 * so the caller can format it however it likes (currency, %, compact).
 */
export function useCountUp(target, { duration = 1100, start = 0, run = true } = {}) {
  const [value, setValue] = useState(start);
  const frame = useRef(0);

  useEffect(() => {
    if (!run) return;
    if (reduced()) {
      setValue(target);
      return;
    }

    const t0 = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      // easeOutExpo - fast off the line, long settle
      const eased = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
      setValue(start + (target - start) * eased);
      if (p < 1) frame.current = requestAnimationFrame(tick);
    };

    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [target, duration, start, run]);

  return value;
}

/**
 * Pointer-tracked 3D tilt. Writes rotation and a glare position to CSS
 * custom properties so the surface can light up as it turns.
 */
export function useTilt({ max = 9, glare = true } = {}) {
  const ref = useRef(null);

  const onMove = useCallback(
    (e) => {
      const el = ref.current;
      if (!el || reduced()) return;
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width;
      const py = (e.clientY - r.top) / r.height;
      el.style.setProperty("--rx", `${(0.5 - py) * max * 2}deg`);
      el.style.setProperty("--ry", `${(px - 0.5) * max * 2}deg`);
      if (glare) {
        el.style.setProperty("--gx", `${px * 100}%`);
        el.style.setProperty("--gy", `${py * 100}%`);
      }
    },
    [max, glare]
  );

  const onLeave = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty("--rx", "0deg");
    el.style.setProperty("--ry", "0deg");
  }, []);

  return { ref, onMouseMove: onMove, onMouseLeave: onLeave };
}

/** Compact currency / number formatting used across the data components. */
export const fmt = {
  money: (n, currency = "$") =>
    currency +
    n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  compact: (n) =>
    n >= 1000
      ? (n / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 }) + "K"
      : Math.round(n).toLocaleString("en-US"),
  int: (n) => Math.round(n).toLocaleString("en-US"),
  pct: (n, dp = 1) => n.toFixed(dp) + "%",
};
