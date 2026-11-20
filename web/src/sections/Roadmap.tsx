import {ROADMAP_ITEMS, statusOf} from '../lib/roadmap';

// Filled in at build time from CHANGELOG.md (vite.config.ts); empty when the page is built without it.
const LIVE: readonly string[] = typeof __ROADMAP_LIVE__ === 'undefined' ? [] : __ROADMAP_LIVE__;

/** The /roadmap page: the 24 launch updates by day, each Scheduled or LIVE. */
export function Roadmap({navigate}: {navigate: (path: string) => void}) {
  const days = [1, 2].map((day) => ({day, items: ROADMAP_ITEMS.filter((i) => i.day === day)}));
  return (
    <div className="min-h-screen bg-fog text-ink">
      <header className="mx-auto flex h-14 max-w-[1440px] items-center justify-between px-5 md:h-16 md:px-10">
        <a href="/" onClick={(e) => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); navigate('/'); } }}>
          <span className="text-[0.9rem] font-semibold tracking-[-0.04em]">OVERDRIVE</span>
        </a>
        <a href="/dashboard" onClick={(e) => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); navigate('/dashboard'); } }} className="link-underline text-ui">Open the app</a>
      </header>
      <main className="mx-auto max-w-[960px] px-5 pt-10 pb-24 md:px-10 md:pt-16">
        <p className="font-mono text-[0.66rem] uppercase tracking-[0.08em] text-stone">Roadmap</p>
        <h1 className="mt-3 font-display text-[clamp(2.2rem,4.4vw,3.6rem)] leading-[1.04] font-normal tracking-[-0.04em]">What's next</h1>
        <p className="mt-5 max-w-[40rem] text-[0.95rem] text-stone">
          One small, checkable update about every 2 hours for the first 48 hours. Each one has a test, a changelog entry and release notes. An item says LIVE only when its changelog entry exists; until then it says Scheduled. If something is delayed, we say so here.
        </p>
        {days.map(({day, items}) => (
          <section key={day} className="mt-14" aria-labelledby={`day-${day}`}>
            <h2 id={`day-${day}`} className="border-b border-line pb-3 font-mono text-[0.72rem] uppercase tracking-[0.08em]">Day {day}</h2>
            <ol>
              {items.map((item) => {
                const status = statusOf(item, LIVE);
                return (
                  <li key={item.id} id={item.id} className="flex items-baseline gap-4 border-b border-line py-4">
                    <span className="w-24 shrink-0 font-mono text-[0.66rem] uppercase tracking-[0.08em] text-stone">Update {item.number}</span>
                    <span className="flex-1 text-[0.95rem]">{item.title}</span>
                    <span data-status={status} className={`shrink-0 rounded-full px-2.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-[0.08em] ${status === 'LIVE' ? 'bg-lichen text-white' : 'border border-line text-stone'}`}>{status}</span>
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
        <section className="mt-14">
          <h2 className="font-mono text-[0.72rem] uppercase tracking-[0.08em]">Coming soon</h2>
          <p className="mt-3 max-w-[40rem] text-[0.95rem] text-stone">Nothing else is promised past update 24.</p>
        </section>
        <p className="mt-14 max-w-[40rem] text-[0.78rem] text-stone">
          Every item is something you can check: a page, an API route, a script or a test in the public repo. No item changes the contracts. Contract changes only happen through the 48 hour timelock and are announced there first.
        </p>
      </main>
    </div>
  );
}
