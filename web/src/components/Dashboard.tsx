import {useMemo, useState} from 'react';
import {dashboard as d} from '../content';
import {CountUp} from './ui';

const BARS = 96;

/** The product shot in the hero: a live-feeling wealth dashboard. */
export function Dashboard() {
  const [tab, setTab] = useState(1);
  const [hover, setHover] = useState<number | null>(null);

  const bars = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < BARS; i++) {
      const t = i / (BARS - 1);
      const power = [1.5, 2, -1][tab];
      const response = ((1 + t * 0.2) ** power - 1) * 100;
      out.push(0.35 + response / 70);
    }
    return out;
  }, [tab]);

  const hi = hover ?? BARS - 1;
  const power = [1.5, 2, -1][tab];
  const hiMove = hi / (BARS - 1) * 20;
  const hiValue = ((1 + hiMove / 100) ** power - 1) * 100;
  const result = ((1.1 ** power - 1) * 100);

  return (
    <div className="relative flex h-full overflow-hidden rounded-[18px] bg-white text-ink shadow-[0_40px_120px_-40px_rgba(20,21,21,0.45),0_0_0_1px_rgba(20,21,21,0.06)]">
      {/* sidebar */}
      <aside className="hidden w-[22%] min-w-[170px] shrink-0 flex-col gap-4 bg-linear-to-b from-[#302e2f] via-[#626166] to-[#bab9bd] p-4 text-white sm:flex">
        <div className="flex items-center gap-2.5">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-white/15 text-sm">↗</span>
          <div className="leading-tight">
            <p className="text-[0.7rem] font-medium">{d.workspace}</p>
            <p className="text-[0.58rem] opacity-60">{d.plan} explorer</p>
          </div>
        </div>
        <div className="rounded-lg bg-white/10 px-2.5 py-1.5 text-[0.6rem] opacity-70">Stocks · Crypto · Index ETFs</div>
        <ul className="flex flex-col gap-0.5 text-[0.66rem]">
          {d.nav.map((n) => (
            <li key={n.label}>
              <p className={`flex items-center gap-2 rounded-md px-2 py-1.5 ${n.active ? 'bg-white/14' : 'opacity-75'}`}>
                <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
                {n.label}
              </p>
              {n.children && (
                <ul className="ml-[0.7rem] border-l border-white/20 pl-3 text-[0.6rem] opacity-65">
                  {n.children.map((c) => (
                    <li key={c} className="py-1">
                      {c}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-auto text-[0.58rem] opacity-60">Robinhood Chain · USDG</p>
      </aside>

      {/* main */}
      <div className="flex min-w-0 flex-1 flex-col gap-4 p-4 md:p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="h-7 w-7 rounded-full bg-[radial-gradient(circle_at_35%_30%,#f3c4bf,#c94e45)]" />
            <div className="leading-tight">
              <p className="text-[0.56rem] text-stone">{d.role}</p>
              <p className="text-[0.7rem] font-medium">{d.user}</p>
            </div>
          </div>
          <div className="hidden items-center gap-3 text-[0.6rem] text-slate md:flex">
            <span className="flex items-center gap-1.5">
              <span className="relative h-3 w-5 rounded-full bg-ink">
                <span className="absolute top-0.5 right-0.5 h-2 w-2 rounded-full bg-white" />
              </span>
              Exposure
            </span>
            <span>{d.range} ▾</span>
            <span className="rounded-full bg-mist px-2 py-1">{d.date}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="font-mono text-[0.55rem] tracking-[0.12em] text-stone uppercase">{d.tabs[tab]} · token response</p>
            <p className="mt-1 flex items-center gap-2 text-[clamp(1.2rem,2.2vw,1.9rem)] font-medium tracking-[-0.04em]">
              <span>{result > 0 ? "+" : ""}{result.toFixed(1)}%</span>
              <span className="rounded-full bg-cream px-1.5 py-0.5 text-[0.56rem] font-medium tracking-normal text-ember">Power {power}</span>
            </p>
          </div>
          <div className="flex gap-1 rounded-full bg-mist p-0.5 text-[0.58rem]">
            {d.tabs.map((t, i) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(i)}
                className={`rounded-full px-2 py-0.5 transition-colors ${tab === i ? 'bg-white text-ink shadow-sm' : 'text-stone hover:text-ink'}`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {d.holdings.map((h) => (
            <div key={h.label} className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full" style={{background: h.dot}} />
              <div className="leading-tight">
                <p className="text-[0.78rem] font-medium tracking-[-0.02em]">
                  <CountUp to={h.value} prefix={h.value > 0 ? "+" : ""} suffix="%" decimals={1} duration={1800} />
                </p>
                <p className="text-[0.55rem] text-stone">{h.label}</p>
              </div>
            </div>
          ))}
          <div className="ml-auto hidden gap-4 text-[0.58rem] text-slate lg:flex">
            {d.stats.map((s) => (
              <span key={s.label}>
                {s.label} <b className="font-medium text-ember">{s.value}</b>
              </span>
            ))}
          </div>
        </div>

        {/* comb chart */}
        <div className="relative h-[clamp(70px,11vw,140px)]" onPointerLeave={() => setHover(null)}>
          <div className="absolute inset-0 flex items-end gap-[2px]">
            {bars.map((v, i) => (
              <span
                key={i}
                onPointerEnter={() => setHover(i)}
                className="flex-1 rounded-t-[1px] transition-[height,background-color] duration-700 ease-(--ease-soft)"
                style={{
                  height: `${v * 100}%`,
                  background: i > BARS * 0.62 ? (i === hi ? 'var(--color-lichen)' : '#b9b9be') : i === hi ? 'var(--color-lichen)' : '#e2e2e6',
                  transitionDelay: `${i * 4}ms`,
                }}
              />
            ))}
          </div>
          <div
            className="pointer-events-none absolute -top-1 -translate-x-1/2 rounded-md bg-ink px-1.5 py-0.5 text-[0.55rem] whitespace-nowrap text-white transition-[left] duration-200"
            style={{left: `${((hi + 0.5) / BARS) * 100}%`}}
          >
            {hiValue > 0 ? "+" : ""}{hiValue.toFixed(1)}% · market +{hiMove.toFixed(1)}%
          </div>
        </div>

        <div className="hidden flex-col text-[0.6rem] md:flex">
          <div className="grid grid-cols-[1.6fr_1fr_1fr_0.7fr] border-b border-line pb-1.5 text-stone">
            <span>Geared token</span>
            <span>Gear</span>
            <span>Market +10%</span>
            <span className="text-right">Market −10%</span>
          </div>
          {d.rows.map((r) => (
            <div key={r.name} className="grid grid-cols-[1.6fr_1fr_1fr_0.7fr] border-b border-line/70 py-1.5">
              <span className="font-medium">{r.name}</span>
              <span className="text-stone">{r.kind}</span>
              <span>{r.value}</span>
              <span className="text-right text-ember">{r.change}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
