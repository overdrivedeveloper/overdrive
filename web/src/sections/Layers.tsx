import {useEffect, useRef, type CSSProperties} from 'react';
import {BlurWords, Eyebrow, Leaf, Reveal} from '../components/ui';
import {layers as l} from '../content';
import {useReveals} from '../hooks/useReveals';
import {clamp, lerp} from '../lib/math';
import {onFrame} from '../lib/scroll';

const VW = 1000;
const VH = 520;
const CORE = {x: 500, y: 250};
// faint "ghost" points that give the plane its depth
const GHOSTS = [
  [140, 120, 0.4],
  [330, 300, 0.7],
  [640, 90, 0.5],
  [760, 410, 0.8],
  [560, 470, 0.6],
  [900, 470, 0.3],
] as const;

/**
 * The tarn core with every layer of wealth wired into it. Lines draw in
 * once; after that the nodes float on a shallow plane - they drift with
 * scroll and lean away from the pointer by depth, and the lines follow.
 */
export function Layers({reduced}: {reduced: boolean}) {
  const root = useReveals<HTMLElement>();
  const nodes = useRef<(SVGGElement | null)[]>([]);
  const lines = useRef<(SVGLineElement | null)[]>([]);
  const ghosts = useRef<(SVGGElement | null)[]>([]);

  useEffect(() => {
    if (reduced) return;
    const ptr = {x: 0, y: 0, tx: 0, ty: 0};
    const onMove = (e: PointerEvent) => {
      ptr.tx = e.clientX / window.innerWidth - 0.5;
      ptr.ty = e.clientY / window.innerHeight - 0.5;
    };
    window.addEventListener('pointermove', onMove, {passive: true});
    const depths = l.nodes.map((_, i) => 0.5 + ((i * 37) % 10) / 10);
    const stop = onFrame((t) => {
      const el = root.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) return;
      const sp = clamp(1 - r.top / window.innerHeight, 0, 2) - 1; // -1..1 through the viewport
      ptr.x = lerp(ptr.x, ptr.tx, 0.05);
      ptr.y = lerp(ptr.y, ptr.ty, 0.05);
      l.nodes.forEach((n, i) => {
        const z = depths[i];
        const x = n.x * VW + ptr.x * -60 * z + Math.sin(t / 2400 + i) * 6;
        const y = n.y * VH + ptr.y * -40 * z - sp * 50 * z + Math.cos(t / 2800 + i * 2) * 5;
        nodes.current[i]?.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
        const ln = lines.current[i];
        if (ln) {
          ln.setAttribute('x2', x.toFixed(1));
          ln.setAttribute('y2', y.toFixed(1));
        }
      });
      GHOSTS.forEach(([gx, gy, z], i) => {
        ghosts.current[i]?.setAttribute('transform', `translate(${(gx + ptr.x * -60 * z).toFixed(1)} ${(gy + ptr.y * -40 * z - sp * 50 * z).toFixed(1)})`);
      });
    });
    return () => {
      stop();
      window.removeEventListener('pointermove', onMove);
    };
  }, [reduced, root]);

  return (
    <section ref={root} className="relative overflow-hidden bg-fog px-5 pt-24 pb-20 md:px-10 md:pt-32">
      <div className="pointer-events-none absolute -top-40 -left-40 h-[36rem] w-[50rem] rounded-full bg-[radial-gradient(closest-side,rgba(216,71,61,0.16),transparent)]" />
      <div className="relative mx-auto max-w-[1440px]">
        <Reveal as="h2" className="font-display text-title font-normal">
          <BlurWords text={l.titleA} className="text-haze" />
          <br />
          <BlurWords text={l.titleB} start={2} />
        </Reveal>

        <Reveal className="relative mt-6 md:-mt-10">
          <svg viewBox={`0 0 ${VW} ${VH}`} className="w-full overflow-visible max-sm:-ml-[35%] max-sm:w-[170%]" aria-label="The Governor connected to all five Overdrive gears">
            {/* perspective plane */}
            <g stroke="var(--color-line)" strokeWidth="1" fill="none" opacity="0.8">
              {[0, 1, 2, 3, 4].map((i) => (
                <line key={`h${i}`} x1={80 + i * 20} y1={130 + i * 80} x2={920 - i * 20} y2={130 + i * 80} strokeDasharray="2 6" />
              ))}
              {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                <line key={`v${i}`} x1={200 + i * 100} y1={110} x2={120 + i * 127} y2={470} strokeDasharray="2 6" />
              ))}
            </g>

            {l.nodes.map((n, i) => (
              <line
                key={n.id}
                ref={(e) => void (lines.current[i] = e)}
                className="draw"
                style={{'--len': 700, '--d': `${300 + i * 140}ms`} as CSSProperties}
                x1={CORE.x}
                y1={CORE.y}
                x2={n.x * VW}
                y2={n.y * VH}
                stroke="#b9b9be"
                strokeWidth="1"
              />
            ))}

            {GHOSTS.map(([gx, gy], i) => (
              <g key={i} ref={(e) => void (ghosts.current[i] = e)} transform={`translate(${gx} ${gy})`}>
                <rect x="-5" y="-5" width="10" height="10" rx="2" fill="#e4e4e7" />
              </g>
            ))}

            {l.nodes.map((n, i) => (
              <g key={n.id} ref={(e) => void (nodes.current[i] = e)} transform={`translate(${n.x * VW} ${n.y * VH})`}>
                <circle r="16" fill="var(--color-lichen)" opacity="0.18" className="pulse-ring" style={{transformBox: 'fill-box', transformOrigin: 'center', animationDelay: `${i * 0.5}s`}} />
                <circle r="6.5" fill="var(--color-slate)" stroke="white" strokeWidth="2.5" />
                <text x={n.x > 0.5 ? -14 : 14} y="22" textAnchor={n.x > 0.5 ? 'end' : 'start'} className="fill-slate font-mono text-[10px] uppercase" letterSpacing="0.08em">
                  {n.label}
                </text>
              </g>
            ))}

            {/* core */}
            <g transform={`translate(${CORE.x} ${CORE.y})`}>
              <text y="-56" textAnchor="middle" className="fill-ink font-mono text-[10px] uppercase" letterSpacing="0.1em">
                {l.core}
              </text>
              <g stroke="var(--color-ink)" strokeWidth="1.4" fill="none">
                <path d="M-40 -28v-12h12M40 -28v-12h-12M-40 28v12h12M40 28v12h-12" />
              </g>
              <circle r="22" fill="var(--color-lichen)" opacity="0.15" className="pulse-ring" style={{transformBox: 'fill-box', transformOrigin: 'center'}} />
              <circle r="13" fill="var(--color-ink)" />
              <path d="M-5 0h10M0-5v10" stroke="var(--color-lichen)" strokeWidth="2" fill="none" strokeLinecap="round" />
              {l.coreNote.map((c, i) => (
                <text key={c} y={64 + i * 14} textAnchor="middle" className="fill-stone text-[10px]">
                  {c}
                </text>
              ))}
            </g>
          </svg>
        </Reveal>

        <div className="mt-6 grid gap-10 border-t border-line pt-10 md:grid-cols-[1.3fr_1fr_1fr_1fr] md:gap-8">
          <Reveal>
            <Eyebrow className="text-stone">
              <BlurWords text={l.eyebrow} />
            </Eyebrow>
            <p className="mt-3 text-[clamp(1.2rem,1.7vw,1.6rem)] leading-[1.05] font-normal tracking-[-0.03em] uppercase">
              <BlurWords text={l.capsTitle[0]} />
              <br />
              <BlurWords text={l.capsTitle[1]} start={3} />
            </p>
          </Reveal>
          {l.caps.map((c, i) => (
            <div key={c.title} data-reveal="rise" style={{'--d': `${i * 140}ms`} as CSSProperties}>
              <Leaf className="text-ink" />
              <h3 className="mt-3 text-ui font-medium">{c.title}</h3>
              <p className="mt-1.5 max-w-[16rem] text-[0.74rem] leading-snug text-stone">{c.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
