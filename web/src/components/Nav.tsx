import {useEffect, useState} from 'react';
import {nav} from '../content';
import {scrollToHash} from '../lib/scroll';

const targets = ['#features', '#gears', '#markets', '#details', '#mechanics', '#risks'];


/** Light over the hero; turns into a dark bar (and shows "Request access") once you scroll past it. */
export function Nav({navigate}: {navigate:(path:string)=>void}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dark, setDark] = useState(false);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const closeMenu = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', closeMenu);
    return () => window.removeEventListener('keydown', closeMenu);
  }, []);

  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    const onScroll = () => setDark(window.scrollY > window.innerHeight * 0.82);
    onScroll();
    window.addEventListener('scroll', onScroll, {passive: true});
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-[background-color,color,opacity,filter] duration-700 ease-(--ease-soft) ${
        dark ? 'bg-night text-white' : 'bg-fog/80 text-ink backdrop-blur-md'
      } ${shown ? 'opacity-100 blur-none' : 'opacity-0 blur-md'}`}
    >
      <nav className="mx-auto flex h-14 max-w-[1440px] items-center justify-between px-5 md:h-16 md:px-10">
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            scrollToHash('#top');
          }}
        >
          <span className="text-[0.9rem] font-semibold tracking-[-0.04em]">OVERDRIVE</span>
        </a>
        <ul className="absolute left-1/2 hidden -translate-x-1/2 gap-4 xl:gap-7 whitespace-nowrap font-mono text-[0.62rem] xl:text-[0.66rem] uppercase tracking-[0.08em] md:flex">
          {nav.links.map((l, i) => (
            <li key={l}>
              <a href={targets[i]} onClick={(e)=>{if(!e.metaKey&&!e.ctrlKey&&!e.shiftKey){e.preventDefault();scrollToHash(targets[i])}}} className="link-underline pb-0.5 opacity-80 transition-opacity hover:opacity-100">
                {l}
              </a>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-2 text-ui">
          <span className="hidden items-center gap-1.5 px-2 opacity-80 xl:flex">
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden>
              <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.2" fill="none" />
              <path d="M1.8 8h12.4M8 1.8c2 2 2 10.4 0 12.4M8 1.8c-2 2-2 10.4 0 12.4" stroke="currentColor" strokeWidth="1.1" fill="none" />
            </svg>
            {nav.lang}
          </span>
          <a
            href="#gears"
            className={`hidden rounded-full px-3.5 py-1.5 transition-all duration-700 xl:block ${
              dark ? 'bg-white/12 opacity-100 hover:bg-white/20' : 'pointer-events-none w-0 overflow-hidden px-0 opacity-0'
            }`}
          >
            {nav.request}
          </a>
          <a
            href="/dashboard"
            onClick={(e)=>{if (!e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {e.preventDefault();navigate("/dashboard")}}}
            className={`flex items-center gap-2 rounded-full py-1.5 pr-3.5 pl-1.5 font-medium transition-colors duration-700 ${
              dark ? 'bg-white text-ink' : 'bg-ink text-white'
            }`}
          >
            <span className={`grid h-5 w-5 place-items-center rounded-full ${dark ? 'bg-ink text-white' : 'bg-white text-ink'}`}>
              <svg viewBox="0 0 10 10" className="h-2 w-2" aria-hidden>
                <path d="M2 5h6M5.5 2.5L8 5 5.5 7.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
              </svg>
            </span>
            {nav.cta}
          </a>
          <button type="button" className="ml-1 grid h-9 w-9 place-items-center rounded-full border border-current/20 md:hidden" aria-label={menuOpen ? "Close navigation" : "Open navigation"} aria-expanded={menuOpen} onClick={()=>setMenuOpen(!menuOpen)}>{menuOpen ? "×" : "☰"}</button>
        </div>
      </nav>
      {menuOpen && <div className="flex flex-col gap-5 border-t border-current/10 px-5 py-6 md:hidden">{nav.links.map((label,i)=><a key={label} href={targets[i]} onClick={(e)=>{setMenuOpen(false);if(!e.metaKey&&!e.ctrlKey&&!e.shiftKey){e.preventDefault();scrollToHash(targets[i])}}} className="font-mono text-sm uppercase">{label}</a>)}</div>}
    </header>
  );
}
