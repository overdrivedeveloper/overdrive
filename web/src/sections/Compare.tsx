import {useEffect, useRef, type CSSProperties} from 'react';
import {BlurWords, Check, Eyebrow, Reveal, useInView} from '../components/ui';
import {compare as c} from '../content';
import {clamp} from '../lib/math';
import {onFrame} from '../lib/scroll';

/**
 * Fog clears onto a field of lichen boulders; a glass table rises, the tarn
 * column lifts out of it and the "typical app" column slides out from
 * behind it.
 */
export function Compare({reduced}: {reduced: boolean}) {
  const section = useRef<HTMLElement>(null);
  const bg = useRef<HTMLDivElement>(null);
  const veil = useRef<HTMLDivElement>(null);
  const [table, inView] = useInView<HTMLDivElement>('-18%');

  useEffect(() => {
    if (reduced) {
      if (veil.current) veil.current.style.opacity = "0";
      return;
    }
    return onFrame(() => {
      const el = section.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      if (r.bottom < 0 || r.top > vh) return;
      const p = clamp((vh - r.top) / (vh * 0.9));
      if (veil.current) veil.current.style.opacity = String(1 - p);
      if (bg.current) bg.current.style.transform = `translate3d(0, ${(1 - p) * 60 - clamp(-r.top / vh) * 40}px, 0) scale(${1.12 - p * 0.08})`;
    });
  }, [reduced]);

  const cell = (v: boolean | string) =>
    v === true ? <Check className="mx-auto" /> : <span className="text-[0.6rem] text-white/60">{v}</span>;

  return (
    <section id="details" ref={section} className="relative overflow-hidden bg-[#c9c9c8] px-5 pt-28 pb-40 text-white md:pt-36 md:pb-52">
      <div ref={bg} className="absolute inset-0 will-change-transform">
        <img src="/media/stones.webp" alt="" className="h-full w-full object-cover object-bottom" />
      </div>
      <div className="absolute inset-0 bg-linear-to-b from-[#454549]/30 via-[#454549]/10 to-[#26262a]/30" />
      <div ref={veil} className="pointer-events-none absolute inset-0 bg-fog" />

      <div className="relative mx-auto max-w-5xl text-center">
        <Reveal>
          <Eyebrow className="text-white/70">
            <BlurWords text={c.eyebrow} />
          </Eyebrow>
          <h2 className="mt-4 font-display text-title font-normal [text-shadow:0_2px_30px_rgba(60,60,58,0.25)]">
            <BlurWords text={c.title[0]} />
            <br />
            <BlurWords text={c.title[1]} start={4} />
          </h2>
          <p className="mx-auto mt-5 max-w-md text-body text-white/80">
            <BlurWords text={c.body} delay={300} />
          </p>
        </Reveal>

        <div ref={table} className={`relative mx-auto mt-14 max-w-3xl text-left ${inView ? 'is-in' : ''}`}>
          <div className="grid grid-cols-[1fr_8.5rem_7.5rem] items-end max-sm:grid-cols-[1fr_5.5rem_5.5rem]">
            {/* left panel: labels */}
            <div
              data-reveal="rise"
              className={`glass-dark rounded-l-[16px] py-4 pl-5 ${inView ? 'is-in' : ''}`}
            >
              <p className="pb-3 text-[0.62rem] text-white/60">{c.head}</p>
              {c.rows.map((r) => (
                <p key={r.label} className="flex h-9 items-center text-[0.74rem]">
                  {r.label}
                </p>
              ))}
            </div>
            {/* tarn column, lifted */}
            <div
              className={`relative z-10 -mt-6 rounded-[16px] bg-cream py-4 text-center text-ink shadow-[0_30px_60px_-24px_rgba(40,30,10,0.55)] transition-all duration-[1200ms] ease-(--ease-soft) ${
                inView ? 'translate-y-0 opacity-100 blur-none' : 'translate-y-10 opacity-0 blur-md'
              }`}
              style={{transitionDelay: '200ms'}}
            >
              <div className="flex h-[2.4rem] items-start justify-center pt-1">
                <span className="text-[0.75rem] font-medium">{c.ours}</span>
              </div>
              {c.rows.map((r) => (
                <p key={r.label} className="flex h-9 items-center justify-center text-ember">
                  {r.ours}
                </p>
              ))}
            </div>
            {/* typical app column, slides out from behind */}
            <div
              className={`glass-dark rounded-r-[16px] py-4 text-center transition-all duration-[1200ms] ease-(--ease-soft) ${
                inView ? 'translate-x-0 opacity-100' : '-translate-x-full opacity-0'
              }`}
              style={{transitionDelay: '700ms'} as CSSProperties}
            >
              <p className="pb-3 text-[0.62rem] text-white/60">{c.theirs}</p>
              {c.rows.map((r) => (
                <p key={r.label} className="flex h-9 items-center justify-center">
                  {cell(r.theirs)}
                </p>
              ))}
            </div>
          </div>
          <div
            className={`grid grid-cols-[1fr_8.5rem_7.5rem] px-5 pt-5 text-[0.7rem] transition-opacity delay-1000 duration-1000 max-sm:grid-cols-[1fr_5.5rem_5.5rem] ${inView ? 'opacity-100' : 'opacity-0'}`}
          >
            <div>
              <p className="font-medium">{c.costLabel}</p>
              <p className="text-[0.6rem] text-white/60">{c.costNote}</p>
            </div>
            <p className="text-center font-medium">{c.oursCost}</p>
            <p className="text-center text-white/70">{c.theirsCost}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
