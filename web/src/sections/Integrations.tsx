import {useEffect, useRef} from 'react';
import {BlurWords, Eyebrow, Reveal} from '../components/ui';
import {integrations as it} from '../content';
import {clamp} from '../lib/math';
import {onFrame} from '../lib/scroll';

const STYLES = [
  'bg-white text-ink',
  'bg-ink text-white',
  'bg-cream text-ember',
  'bg-mist text-slate',
  'bg-lichen text-white',
  'bg-[#f0d8d6] text-moss',
];

/**
 * Monogram marks ride an arch around the pill in the middle; scrolling turns
 * the arch so marks travel up one side, pass behind the pill and down the
 * other. Marks grow toward the crown of the arc.
 */
export function Integrations({reduced}: {reduced: boolean}) {
  const section = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const marks = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const n = it.marks.length;
    const span = 2.6; // radians the arch covers
    const place = (offset: number) => {
      const st = stage.current;
      if (!st) return;
      const w = st.clientWidth;
      const rx = Math.min(w * 0.46, 560);
      const ry = Math.min(150, w * 0.22);
      marks.current.forEach((m, i) => {
        if (!m) return;
        // wrap each mark's angle into [-span/2, span/2)
        let a = ((i / n) * span + offset) % span;
        if (a < 0) a += span;
        a -= span / 2;
        const edge = Math.abs(a) / (span / 2);
        const x = Math.sin(a) * rx;
        const y = (1 - Math.cos(a)) * ry * 1.6;
        const s = 1.15 - edge * 0.6;
        // hidden behind the pill near the crown, faded at the ends
        const behind = clamp((Math.abs(x) - 70) / 50);
        const o = clamp((1 - edge) * 4) * behind;
        m.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) scale(${s.toFixed(3)})`;
        m.style.opacity = o.toFixed(3);
      });
    };
    place(0.12);
    if (reduced) {
      const resize = () => place(0.12);
      window.addEventListener("resize", resize);
      return () => window.removeEventListener("resize", resize);
    }
    return onFrame((t) => {
      const el = section.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) return;
      const p = (window.innerHeight - r.top) / (window.innerHeight + r.height);
      place(p * 1.6 + t / 60000);
    });
  }, [reduced]);

  return (
    <section id="markets" ref={section} className="relative overflow-hidden bg-fog px-5 pt-24 pb-28 text-center md:pt-36">
      <Reveal>
        <Eyebrow className="mx-auto w-fit rounded-md border border-line px-2 py-1 text-stone">
          <BlurWords text={it.eyebrow} />
        </Eyebrow>
        <h2 className="mt-5 font-display text-title font-normal">
          <BlurWords text={it.title[0]} />
          <br />
          <BlurWords text={it.title[1]} start={2} />
        </h2>
      </Reveal>

      <div ref={stage} className="relative mx-auto mt-14 h-[clamp(220px,30vw,320px)] max-w-[1200px]">
        <div className="absolute top-6 left-1/2 h-0 w-0">
          {it.marks.map((m, i) => (
            <div
              key={i}
              ref={(e) => void (marks.current[i] = e)}
              className={`absolute -top-6 -left-6 grid h-12 w-12 place-items-center rounded-full font-display text-[0.56rem] font-medium shadow-[0_10px_30px_-12px_rgba(20,21,21,0.35)] ring-1 ring-black/5 will-change-transform ${STYLES[i % STYLES.length]}`}
            >
              {m}
            </div>
          ))}
        </div>
        <Reveal className="absolute top-0 left-1/2 z-10 -translate-x-1/2">
          <div className="relative flex h-14 w-[min(17rem,70vw)] items-center justify-center overflow-hidden rounded-full shadow-[0_20px_50px_-20px_rgba(20,21,21,0.5)] ring-1 ring-white/60">
            <img src="/media/pill-fungi.webp" alt="" className="absolute inset-0 h-full w-full object-cover" />
            <span className="absolute inset-0 bg-linear-to-r from-black/35 via-black/10 to-black/35" />
            <p className="relative text-[1.05rem] tracking-[-0.02em] text-white">
              <b className="font-semibold">{it.pill}</b> - {it.pillNote}
            </p>
          </div>
        </Reveal>
        <Reveal className="absolute inset-x-0 top-[38%] mx-auto max-w-md">
          <p className="text-ui font-medium">
            <BlurWords text={it.caption} />
          </p>
          <p className="mt-3 text-[0.74rem] leading-relaxed text-stone">
            <BlurWords text={it.body} delay={250} />
          </p>
        </Reveal>
      </div>
    </section>
  );
}
