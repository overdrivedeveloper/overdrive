import {useEffect, useRef, type CSSProperties} from 'react';
import {Dashboard} from '../components/Dashboard';
import {GrowReveal} from '../components/GrowReveal';
import {BlurWords, Eyebrow, Reveal} from '../components/ui';
import {hero} from '../content';
import {useReveals} from '../hooks/useReveals';
import {clamp} from '../lib/math';
import {onFrame} from '../lib/scroll';

/**
 * Words sharpen in, the dashboard rises between two foreground boulders,
 * and the boulders grow alpine moss and saxifrage wherever the pointer moves.
 * On scroll the stones (nearest the camera) lift faster than the dashboard
 * and the headline drifts back into the fog.
 */
export function Hero({reduced}: {reduced: boolean}) {
  const root = useReveals<HTMLElement>();
  const copy = useRef<HTMLDivElement>(null);
  const stones = useRef<(HTMLDivElement | null)[]>([]);
  const board = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (reduced) return;
    return onFrame(() => {
      const y = window.scrollY;
      const vh = window.innerHeight;
      if (y > vh * 1.4) return;
      const p = clamp(y / vh);
      if (copy.current) {
        copy.current.style.transform = `translate3d(0, ${y * 0.32}px, 0)`;
        copy.current.style.opacity = String(1 - p * 1.3);
        copy.current.style.filter = `blur(${p * 10}px)`;
      }
      const st = `translate3d(-50%, ${-y * 0.18}px, 0) scale(${1 + p * 0.06})`;
      stones.current.forEach((el) => el && (el.style.transform = st));
      if (board.current) board.current.style.transform = `translate3d(-50%, ${y * 0.06}px, 0)`;
    });
  }, [reduced]);

  return (
    <section ref={root} id="top" className="relative h-[100svh] min-h-[680px] overflow-hidden bg-fog">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_70%_at_50%_0%,#ffffff_0%,rgba(255,255,255,0)_60%)]" />

      <div ref={copy} className="relative z-10 mx-auto flex max-w-4xl flex-col items-center px-5 pt-[clamp(6.5rem,15vh,9.5rem)] text-center will-change-transform">
        <Reveal margin="0%">
          <Eyebrow className="text-stone">
            <BlurWords text={hero.eyebrow} />
          </Eyebrow>
          <h1 className="mt-4 font-display text-hero font-normal">
            <BlurWords text={hero.lineA} className="text-haze" delay={120} />
            <br />
            <BlurWords text={hero.lineB} delay={120} start={2} />
          </h1>
          <p className="mx-auto mt-5 max-w-md text-body text-stone">
            <BlurWords text={hero.sub} delay={500} />
          </p>
        </Reveal>
      </div>

      <div
        ref={board}
        className="absolute top-[clamp(25rem,52vh,34rem)] left-1/2 z-10 w-[min(1040px,92vw)] [transform:translate3d(-50%,0,0)] sm:w-[min(1040px,72vw)]"
      >
        <div data-reveal="rise" style={{'--d': '650ms'} as CSSProperties} className="h-[min(560px,60vh)]">
          <Dashboard />
        </div>
      </div>

      {/* Boulders, split at the gap between them: the left one sits behind the
          dashboard, the right one in front of it. Same
          image pair, clipped to each half; both share one parallax transform. */}
      {(['left', 'right'] as const).map((side, i) => (
        <div
          key={side}
          ref={(el) => void (stones.current[i] = el)}
          className={`pointer-events-none absolute bottom-0 left-1/2 w-[max(100vw,170vh)] origin-bottom [transform:translate3d(-50%,0,0)] max-sm:w-[190vw] ${
            side === 'left' ? 'z-[5] [clip-path:inset(-20%_50%_0_0)]' : 'z-20 [clip-path:inset(-20%_0_0_50%)]'
          }`}
        >
          <div data-reveal="fade" style={{'--d': '200ms'} as CSSProperties}>
            <GrowReveal bare="/media/rocks-bare.webp" grown="/media/rocks-grown.webp" aspect={2688 / 1520} radius={130} reduced={reduced} alt="" />
          </div>
        </div>
      ))}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 h-24 bg-linear-to-t from-fog/70 to-transparent" />
      <a
        href="#features"
        data-reveal="fade"
        style={{'--d': '1400ms'} as CSSProperties}
        className="absolute bottom-5 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 font-mono text-label text-slate uppercase"
      >
        <span className="nudge">↓</span>
        {hero.scroll}
      </a>
    </section>
  );
}
