import {useEffect, useRef, useState, type CSSProperties, type ReactNode} from 'react';

/** Splits text into words that sharpen from a blur one after another. */
export function BlurWords({text, className = '', delay = 0, start = 0}: {text: string; className?: string; delay?: number; start?: number}) {
  return (
    <span className={`bw ${className}`} data-reveal-words style={{'--d': `${delay}ms`} as CSSProperties}>
      {text.split(' ').map((w, i) => (
        <span key={i} className="w" style={{'--i': i + start} as CSSProperties}>
          {w}
          {' '}
        </span>
      ))}
    </span>
  );
}

/** Adds `.is-in` to every `.bw` / `[data-reveal]` / `.pill-img` inside once it is on screen. */
export function useInView<T extends HTMLElement>(margin = '-12%') {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        setInView(true);
        io.disconnect();
      },
      {rootMargin: `0px 0px ${margin} 0px`},
    );
    io.observe(el);
    return () => io.disconnect();
  }, [margin]);
  return [ref, inView] as const;
}

/** A block whose word / pill children animate in together. */
export function Reveal({children, className = '', as: Tag = 'div', margin}: {children: ReactNode; className?: string; as?: 'div' | 'h1' | 'h2' | 'p' | 'span'; margin?: string}) {
  const [ref, inView] = useInView<HTMLElement>(margin);
  useEffect(() => {
    const el = ref.current;
    if (!el || !inView) return;
    el.classList.add('is-in');
    el.querySelectorAll('.bw, .pill-img').forEach((n) => n.classList.add('is-in'));
  }, [inView, ref]);
  return (
    <Tag ref={ref as never} className={className}>
      {children}
    </Tag>
  );
}

const fmt = (v: number, decimals: number) =>
  v.toLocaleString('en-US', {minimumFractionDigits: decimals, maximumFractionDigits: decimals});

/** Counts from `from` to `to` once visible, then optionally keeps ticking a little. */
export function CountUp({from = 0, to, decimals = 0, duration = 1600, prefix = '', suffix = '', live = 0, className = ''}: {from?: number; to: number; decimals?: number; duration?: number; prefix?: string; suffix?: string; live?: number; className?: string}) {
  const [ref, inView] = useInView<HTMLSpanElement>('-5%');
  const span = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const el = span.current;
    if (!el || !inView) return;
    let raf = 0;
    let liveTimer = 0;
    const t0 = performance.now();
    let current = to;
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / duration);
      const e = 1 - Math.pow(1 - t, 4);
      el.textContent = prefix + fmt(from + (to - from) * e, decimals) + suffix;
      if (t < 1) raf = requestAnimationFrame(step);
      else if (live) {
        liveTimer = window.setInterval(() => {
          current += (Math.random() - 0.35) * live;
          el.textContent = prefix + fmt(current, decimals) + suffix;
        }, 2200);
      }
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(liveTimer);
    };
  }, [inView, from, to, decimals, duration, prefix, suffix, live]);
  return (
    <span
      ref={(n) => {
        span.current = n;
        (ref as {current: HTMLSpanElement | null}).current = n;
      }}
      className={className}
    >
      {prefix + fmt(from, decimals) + suffix}
    </span>
  );
}

export function Eyebrow({children, className = ''}: {children: ReactNode; className?: string}) {
  return <p className={`font-mono text-label uppercase ${className}`}>{children}</p>;
}

export function Logo({className = ''}: {className?: string}) {
  return (
    <span className={`inline-flex items-center gap-2 font-display text-[1.45rem] font-semibold tracking-[-0.06em] ${className}`}>
      <svg viewBox="0 0 32 32" className="h-[1.05em] w-[1.05em]" aria-hidden>
        <path d="M4 22c5-8 9-12 12-12s7 4 12 12" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
        <circle cx="16" cy="25" r="2.2" fill="var(--color-lichen)" />
      </svg>
      tarn
    </span>
  );
}

export function Check({className = ''}: {className?: string}) {
  return (
    <svg viewBox="0 0 16 16" className={`h-3.5 w-3.5 ${className}`} aria-hidden>
      <path d="M3 8.5l3.2 3L13 4.5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Arrow({className = ''}: {className?: string}) {
  return (
    <svg viewBox="0 0 16 16" className={`h-3 w-3 ${className}`} aria-hidden>
      <path d="M4 12L12 4M6 4h6v6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export function Leaf({className = ''}: {className?: string}) {
  return (
    <svg viewBox="0 0 16 16" className={`h-3.5 w-3.5 ${className}`} aria-hidden>
      <path d="M3 13c0-6 4-10 10-10 0 6-4 10-10 10zM3 13l5-5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
    </svg>
  );
}
