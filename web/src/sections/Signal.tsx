import {useEffect, useRef} from 'react';
import {GrowReveal} from '../components/GrowReveal';
import {Leaf} from '../components/ui';
import {signal as s} from '../content';
import {clamp, easeOutCubic, lerp, pinProgress, range} from '../lib/math';
import {onFrame} from '../lib/scroll';

const W = 300;
const H = 90;

/**
 * Pinned stage. A blurred amber card hangs in the fog; as you scroll the
 * birch log slides in behind it, the card turns towards you and its insight
 * builds up piece by piece (chart line, score, actions, chips). The card
 * leans after the pointer, and the log grows fungi and moss under it.
 */
export function Signal({reduced}: {reduced: boolean}) {
  const section = useRef<HTMLElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const chipA = useRef<HTMLDivElement>(null);
  const chipB = useRef<HTMLDivElement>(null);
  const line = useRef<SVGPathElement>(null);
  const area = useRef<SVGPathElement>(null);
  const score = useRef<HTMLSpanElement>(null);
  const value = useRef<HTMLSpanElement>(null);
  const items = useRef<(HTMLLIElement | null)[]>([]);
  const inner = useRef<HTMLDivElement>(null);

  const pts = s.points.map((v, i) => [(i / (s.points.length - 1)) * W, H - v * H] as const);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');

  useEffect(() => {
    const tilt = {x: 0, y: 0, tx: 0, ty: 0};
    const onMove = (e: PointerEvent) => {
      tilt.tx = (e.clientX / window.innerWidth - 0.5) * 2;
      tilt.ty = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    if (!reduced) window.addEventListener('pointermove', onMove, {passive: true});
    const len = line.current?.getTotalLength() ?? 400;
    if (line.current) line.current.style.strokeDasharray = `${len}`;

    const stop = onFrame(() => {
      const el = section.current;
      if (!el) return;
      const {p, rect, vh} = pinProgress(el);
      if (rect.bottom < -vh || rect.top > vh * 1.5) return;
      const P = reduced ? 1 : p;
      // arrive: as the section scrolls in (before pinning) the card sharpens
      const arrive = reduced ? 1 : clamp(1 - rect.top / vh);

      tilt.x = lerp(tilt.x, tilt.tx, 0.06);
      tilt.y = lerp(tilt.y, tilt.ty, 0.06);

      const turn = easeOutCubic(range(P, 0, 0.35));
      if (card.current) {
        const ry = reduced ? -7 : lerp(-22, -7, turn) + tilt.x * 6;
        const rx = reduced ? 3 : lerp(8, 3, turn) - tilt.y * 5;
        const sc = lerp(0.86, 1, easeOutCubic(arrive));
        card.current.style.transform = `perspective(1400px) rotateX(${rx}deg) rotateY(${ry}deg) scale(${sc})`;
        card.current.style.filter = arrive < 1 ? `blur(${(1 - arrive) * 14}px)` : 'none';
        card.current.style.opacity = String(clamp(arrive * 1.4));
      }
      if (log.current) {
        const t = easeOutCubic(range(P, 0, 0.3));
        log.current.style.transform = `translate3d(calc(-50% + ${(1 - t) * 18}vw), -50%, 0)`;
        log.current.style.opacity = String(t);
        log.current.style.filter = t < 1 ? `blur(${(1 - t) * 18}px)` : 'none';
      }
      const showIn = (node: HTMLElement | null, a: number, b: number, dx = 0, dy = 18) => {
        if (!node) return;
        const t = easeOutCubic(range(P, a, b));
        node.style.opacity = String(t);
        node.style.transform = `translate3d(${(1 - t) * dx}px, ${(1 - t) * dy}px, 40px)`;
        node.style.filter = t < 1 ? `blur(${(1 - t) * 8}px)` : 'none';
      };
      showIn(chipA.current, 0.08, 0.26, -30, 0);
      showIn(inner.current, 0.14, 0.3, 0, 12);
      showIn(chipB.current, 0.3, 0.48, 30, 0);
      const draw = range(P, 0.18, 0.5);
      if (line.current) line.current.style.strokeDashoffset = String(len * (1 - draw));
      if (area.current) area.current.style.opacity = String(draw * 0.9);
      if (score.current) score.current.textContent = "+" + lerp(0, s.score, easeOutCubic(draw)).toFixed(1) + "%";
      if (value.current) value.current.textContent = '+' + lerp(0, s.chipValue, easeOutCubic(range(P, 0.08, 0.6))).toFixed(1) + '%';
      items.current.forEach((li, i) => showIn(li, 0.42 + i * 0.09, 0.52 + i * 0.09, 0, 10));
    });
    return () => {
      stop();
      window.removeEventListener('pointermove', onMove);
    };
  }, [reduced]);

  return (
    <section id="gears" ref={section} className="relative h-[280vh] bg-linear-to-b from-white via-fog to-fog">
      <div className="sticky top-0 h-[100svh] overflow-hidden">
        {/* log behind the card */}
        <div ref={log} className="pointer-events-none absolute top-1/2 left-1/2 w-[max(108vw,170vh)] opacity-0 will-change-transform max-sm:w-[220vw]">
          <GrowReveal bare="/media/log-bare.webp" grown="/media/log-grown.webp" aspect={2688 / 1520} radius={110} reduced={reduced} />
        </div>

        <div className="absolute inset-0 grid place-items-center [perspective:1400px]">
          <div ref={card} className="relative w-[min(22rem,74vw)] opacity-0 [transform-style:preserve-3d] will-change-transform">
            <div className="relative aspect-[3/4] overflow-hidden rounded-[22px] shadow-[0_50px_100px_-40px_rgba(40,24,8,0.6)]">
              <div
                className="bloom bloom-drift"
                style={{
                  background:
                    'radial-gradient(40% 35% at 30% 20%, #f2bcb5 0%, transparent 70%), radial-gradient(45% 40% at 75% 45%, #a9463e 0%, transparent 70%), radial-gradient(50% 40% at 30% 70%, #71322f 0%, transparent 70%), radial-gradient(60% 40% at 70% 100%, #1d1416 0%, transparent 70%), linear-gradient(170deg, #c45b51, #2c1c1e)',
                }}
              />
              <div ref={inner} className="absolute inset-0 flex flex-col p-5 text-white opacity-0">
                <div className="mt-[34%] flex items-center justify-between text-ui">
                  <span className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-cream" />
                    {s.cardTitle}
                  </span>
                  <span className="text-white/50">ⓘ</span>
                </div>
                <div className="relative mt-4">
                  <svg viewBox={`0 -8 ${W} ${H + 16}`} className="w-full overflow-visible">
                    <defs>
                      <linearGradient id="sig-a" x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0" stopColor="#f8d6d2" stopOpacity="0.45" />
                        <stop offset="1" stopColor="#f8d6d2" stopOpacity="0" />
                      </linearGradient>
                      <pattern id="sig-h" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                        <line x1="0" y1="0" x2="0" y2="6" stroke="#f8d6d2" strokeOpacity="0.35" strokeWidth="1.2" />
                      </pattern>
                    </defs>
                    <path ref={area} d={`${d} L${W} ${H} L0 ${H} Z`} fill="url(#sig-h)" opacity="0" />
                    <path ref={line} d={d} fill="none" stroke="#f8d6d2" strokeWidth="1.6" strokeLinejoin="round" />
                    {pts.map(([x, y], i) => (
                      <circle key={i} cx={x} cy={y} r="1.8" fill="#f8d6d2" opacity="0.7" />
                    ))}
                  </svg>
                  <span className="absolute top-[18%] left-[58%] grid h-9 w-12 place-items-center rounded-full bg-white text-[0.62rem] font-medium text-ink shadow-md">
                    <span ref={score}>+0%</span>
                  </span>
                </div>
                <ul className="mt-auto flex flex-col gap-1.5 text-[0.66rem]">
                  {s.actions.map((a, i) => (
                    <li key={a} ref={(n) => void (items.current[i] = n)} className="flex items-center gap-2 opacity-0">
                      <span className="grid h-3.5 w-3.5 place-items-center rounded-full bg-white text-[0.45rem] text-ink">✓</span>
                      {a}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* chips float in front of the card */}
            <div ref={chipA} className="glass-light absolute top-[9%] -left-[22%] w-[12.5rem] rounded-[14px] p-3 opacity-0 max-sm:-left-[6%]">
              <div className="flex items-start justify-between">
                <p className="text-[1.15rem] font-medium tracking-[-0.04em]">
                  <span ref={value}>+0%</span>
                </p>
                <span className="text-[0.6rem] text-stone">ⓘ</span>
              </div>
              <p className="text-[0.6rem] text-stone">{s.chipLabel}</p>
              <a href="/dashboard" className="mt-2.5 flex w-full items-center justify-between rounded-full bg-ink py-1.5 pr-1.5 pl-3 text-[0.62rem] text-white">
                {s.chipAction}
                <span className="grid h-4 w-4 place-items-center rounded-full bg-white text-[0.5rem] text-ink">→</span>
              </a>
            </div>
            <div ref={chipB} className="glass-light absolute -right-[20%] bottom-[16%] w-[11rem] rounded-[14px] p-1.5 opacity-0 max-sm:-right-[4%]">
              <p className="flex items-center gap-1.5 px-1.5 pt-0.5 pb-1.5 text-[0.62rem] text-slate">
                <Leaf className="text-lichen" />
                {s.alertTitle}
              </p>
              <p className="rounded-[10px] bg-white px-2.5 py-2 text-[0.64rem] leading-snug shadow-sm">{s.alertBody}</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
