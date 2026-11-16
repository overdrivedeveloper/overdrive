import {type CSSProperties, type ReactNode} from 'react';
import {Arrow, BlurWords, CountUp, Eyebrow, Reveal} from '../components/ui';
import {featureCards as fc, features} from '../content';
import {useReveals} from '../hooks/useReveals';

const BLOOMS = {
  water:
    'radial-gradient(40% 45% at 28% 22%, #d4d4d9 0%, transparent 70%), radial-gradient(50% 50% at 80% 35%, #89898e 0%, transparent 70%), radial-gradient(60% 55% at 45% 95%, #26262a 0%, transparent 70%), linear-gradient(160deg, #b8b8bf, #64646a)',
  lichen:
    'radial-gradient(40% 40% at 25% 25%, #f1b8b0 0%, transparent 70%), radial-gradient(45% 50% at 78% 55%, #9c3e37 0%, transparent 70%), radial-gradient(60% 50% at 40% 100%, #251616 0%, transparent 70%), radial-gradient(30% 30% at 85% 12%, #f7d6d1 0%, transparent 70%), linear-gradient(170deg, #d9675c, #3d2223)',
  moss:
    'radial-gradient(40% 40% at 30% 22%, #e3d5d5 0%, transparent 70%), radial-gradient(45% 50% at 75% 55%, #736c73 0%, transparent 70%), radial-gradient(30% 30% at 88% 14%, #f2dedb 0%, transparent 70%), radial-gradient(60% 50% at 30% 100%, #353236 0%, transparent 70%), linear-gradient(170deg, #ada4a9, #565056)',
};

function Card({bloom, delay, children}: {bloom: keyof typeof BLOOMS; delay: number; children: ReactNode}) {
  return (
    <div
      data-reveal="rise"
      style={{'--d': `${delay}ms`} as CSSProperties}
      className="group relative aspect-[4/4.6] overflow-hidden rounded-[18px] max-md:aspect-[4/4.2]"
    >
      <div className="bloom bloom-drift" style={{background: BLOOMS[bloom]}} />
      <div className="absolute inset-x-[9%] top-[24%] bottom-[-4%] transition-transform duration-700 ease-(--ease-soft) group-hover:-translate-y-2">
        {children}
      </div>
    </div>
  );
}

function WorthPanel() {
  const w = fc.worth;
  return (
    <div className="glass-light flex h-full flex-col gap-3 rounded-[14px] p-4 text-ink">
      <div className="flex items-center justify-between text-ui font-medium">
        {w.title}
        <Arrow className="text-slate" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        {w.figures.map((f) => (
          <div key={f.label}>
            <p className="text-[0.82rem] font-medium tracking-[-0.03em]">{f.value}</p>
            <p className="text-[0.55rem] text-slate">{f.label}</p>
          </div>
        ))}
      </div>
      <div className="flex h-[26%] items-end gap-[3px]">
        {w.bars.map((b, i) => (
          <span
            key={i}
            className="flex-1 rounded-[3px] bg-linear-to-t from-[#64646a]/70 to-white/80"
            style={{height: `${b * 100}%`}}
          />
        ))}
      </div>
      <div className="mt-auto mb-[8%] flex flex-col text-[0.62rem]">
        {w.rows.map((r) => (
          <div key={r.label} className="flex justify-between border-t border-ink/10 py-1.5">
            <span className="text-slate">{r.label}</span>
            <span className="font-medium">{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReturnsPanel() {
  const r = fc.returns;
  return (
    <div className="flex h-full flex-col gap-3 rounded-[14px] bg-[#1c191b]/85 p-4 text-white shadow-[0_30px_60px_-30px_rgba(0,0,0,0.7)] ring-1 ring-white/10 backdrop-blur-xl">
      <div className="flex items-center justify-between text-ui">
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-lichen" />
          {r.title}
        </span>
        <span className="text-white/50">⋮</span>
      </div>
      <p className="mt-[8%] font-display text-[clamp(2.4rem,3.6vw,3.4rem)] leading-none font-light tracking-[-0.05em]">
        <CountUp to={r.figure} decimals={1} suffix="%" duration={1800} />
        <span className="ml-1 align-top text-[0.9rem] text-lichen">↗</span>
      </p>
      <p className="text-ui text-white/90">{r.caption}</p>
      <p className="text-[0.62rem] leading-snug text-white/55">{r.body}</p>
      <div className="mt-auto mb-[8%] grid grid-cols-3 gap-2 border-t border-white/10 pt-2.5">
        {r.stats.map((s) => (
          <div key={s.label}>
            <p className="text-[0.52rem] text-white/50">{s.label}</p>
            <p className="text-[0.7rem] font-medium">{s.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function DriftPanel() {
  const d = fc.drift;
  let acc = 0;
  const R = 15.9155; // circumference 100
  return (
    <div className="glass-dark flex h-full flex-col gap-3 rounded-[14px] p-4 text-white">
      <div className="flex items-center justify-between text-ui">
        {d.title}
        <Arrow className="text-white/70" />
      </div>
      <p className="font-display text-[1.6rem] leading-none font-light tracking-[-0.04em]">
        <CountUp to={d.figure} decimals={1} suffix="%" />
        <span className="ml-2 align-middle text-[0.6rem] tracking-normal text-white/70">{d.caption}</span>
      </p>
      <div className="flex flex-1 items-center gap-4">
        <svg viewBox="0 0 42 42" className="h-auto w-[46%] -rotate-90">
          <circle cx="21" cy="21" r={R} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="5" />
          {d.slices.map((s) => {
            const el = (
              <circle
                key={s.label}
                cx="21"
                cy="21"
                r={R}
                fill="none"
                stroke={s.color}
                strokeWidth="5"
                strokeDasharray={`${s.pct - 0.8} ${100 - s.pct + 0.8}`}
                strokeDashoffset={-acc}
              />
            );
            acc += s.pct;
            return el;
          })}
        </svg>
        <ul className="flex flex-col gap-1.5 text-[0.6rem]">
          {d.slices.map((s) => (
            <li key={s.label} className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full" style={{background: s.color}} />
              <span className="text-white/75">{s.label}</span>
              <span className="font-medium">{s.pct}%</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="mb-[8%] h-1 overflow-hidden rounded-full bg-white/15">
        <div className="h-full w-[60%] rounded-full bg-cream" />
      </div>
    </div>
  );
}

export function Features() {
  const root = useReveals<HTMLElement>();
  return (
    <section ref={root} id="features" className="relative bg-white px-5 pt-28 pb-24 md:px-10 md:pt-36 md:pb-32">
      <div className="mx-auto max-w-[1440px]">
        <Reveal className="grid gap-6 md:grid-cols-[1fr_minmax(0,22rem)] md:items-end">
          <div>
            <Eyebrow className="text-stone">
              <BlurWords text={features.eyebrow} />
            </Eyebrow>
            <h2 className="mt-4 font-display text-title font-normal">
              <BlurWords text={features.title[0]} />
              <br />
              <BlurWords text={features.title[1]} start={4} />
            </h2>
          </div>
          <p className="text-body text-stone">
            <BlurWords text={features.aside} delay={300} />
          </p>
        </Reveal>

        <div className="mt-16 grid gap-x-6 gap-y-10 md:mt-20 md:grid-cols-3">
          {features.items.map((it, i) => (
            <div key={it.n} className="flex flex-col gap-6">
              <div data-reveal="fade" style={{'--d': `${i * 120}ms`} as CSSProperties}>
                <p className="font-mono text-label text-stone">[{it.n}]</p>
                <h3 className="mt-3 text-[1.02rem] font-medium tracking-[-0.02em]">{it.title}</h3>
                <p className="mt-2 max-w-xs text-body text-stone">{it.body}</p>
              </div>
              <Card bloom={(['water', 'lichen', 'moss'] as const)[i]} delay={200 + i * 160}>
                {i === 0 ? <WorthPanel /> : i === 1 ? <ReturnsPanel /> : <DriftPanel />}
              </Card>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
