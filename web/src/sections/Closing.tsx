import {useEffect, useState, type CSSProperties} from 'react';
import {BlurWords, Eyebrow, Leaf, Reveal} from '../components/ui';
import {cta, footer} from '../content';
import {useReveals} from '../hooks/useReveals';
import {Socials} from '../components/Socials';

function Pill({src, delay}: {src: string; delay: number}) {
  return <span className="pill-img" style={{backgroundImage: `url(${src})`, '--d': `${delay}ms`} as CSSProperties} />;
}

/** Four live slots; every few seconds the oldest event drops off and a new one arrives. */
function Feed({reduced}: {reduced: boolean}) {
  const [start, setStart] = useState(0);
  useEffect(() => {
    if (reduced) return;
    const id = window.setInterval(() => setStart((s) => (s + 1) % cta.feed.length), 3200);
    return () => clearInterval(id);
  }, [reduced]);
  const slots = [0, 1, 2, 3].map((i) => cta.feed[(start + i) % cta.feed.length]);
  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
      {slots.map((f, i) => (
        <div key={`${f.title}-${start}-${i}`} className="feed-in" style={{animationDelay: `${i * 90}ms`}}>
          <span className="grid h-5 w-5 place-items-center rounded-md bg-cream text-ember">
            <Leaf className="h-3 w-3" />
          </span>
          <p className="mt-3 text-ui font-medium">{f.title}</p>
          <p className="mt-1 text-[0.66rem] text-stone">{f.body}</p>
        </div>
      ))}
    </div>
  );
}

export function Closing({reduced}: {reduced: boolean}) {
  const root = useReveals<HTMLElement>();
  return (
    <>
      <section id="cta" className="relative overflow-hidden bg-linear-to-b from-fog via-[#f5f5f6] to-[#ededf0] px-5 pt-32 pb-20 md:px-10 md:pt-40">
        <Reveal className="mx-auto max-w-4xl text-center">
          <Eyebrow className="text-stone">
            <BlurWords text={cta.eyebrow} />
          </Eyebrow>
          <h2 className="mt-5 font-display text-hero font-normal">
            <span className="text-haze">
              <BlurWords text={cta.lineA.slice(0, 2).join(' ')} />
            </span>
            <Pill src="/media/pill-lichen.webp" delay={350} />
            <span className="text-haze">
              <BlurWords text={cta.lineA[2] + ','} start={2} />
            </span>
            <br />
            <BlurWords text={cta.lineB.join(' ')} start={3} />
            <Pill src="/media/pill-tarn.webp" delay={650} />
          </h2>
          <p className="mx-auto mt-6 max-w-lg text-body text-stone">
            <BlurWords text={cta.body} delay={400} />
          </p>
        </Reveal>
        <div className="mt-8 flex justify-center gap-2" ref={root as never}>
          <a href="#gears" data-reveal="rise" style={{'--d': '500ms'} as CSSProperties} className="rounded-full bg-white px-4 py-2 text-ui shadow-[0_6px_20px_-10px_rgba(20,21,21,0.3)] ring-1 ring-line transition-colors hover:bg-mist">
            {cta.request}
          </a>
          <a href="/dashboard" data-reveal="rise" style={{'--d': '620ms'} as CSSProperties} className="flex items-center gap-2 rounded-full bg-ink py-2 pr-4 pl-2 text-ui text-white transition-colors hover:bg-slate">
            <span className="grid h-5 w-5 place-items-center rounded-full bg-white text-[0.6rem] text-ink">→</span>
            {cta.open}
          </a>
        </div>

        <div className="mx-auto mt-24 max-w-[1440px] md:mt-32">
          <div className="flex items-center justify-between border-b border-line pb-3">
            <p className="font-mono text-label uppercase">{cta.feedTitle}</p>
            <span className="flex items-center gap-1.5 font-mono text-label text-stone uppercase">
              <span className="live-dot h-1.5 w-1.5 rounded-full bg-lichen" />
              OVERDRIVE
            </span>
          </div>
          <div className="pt-8">
            <Feed reduced={reduced} />
          </div>
        </div>
      </section>

      <footer className="relative overflow-hidden bg-[#ededf0] px-5 pt-16 md:px-10">
        <div className="relative z-10 mx-auto grid max-w-[1440px] gap-12 border-t border-line pt-14 md:grid-cols-[1.4fr_1fr_1fr]">
          <Reveal>
            <h2 className="font-display text-[clamp(1.8rem,2.6vw,2.6rem)] leading-[1.05] font-normal tracking-[-0.04em]">
              <BlurWords text={footer.titleA} />
              <br />
              <BlurWords text={footer.titleB} start={3} />
            </h2>
            <p className="mt-4 max-w-[15rem] text-[0.72rem] text-stone">{footer.body}</p>
          </Reveal>
          {footer.cols.map((c) => (
            <div key={c.title} className="flex flex-col border-l border-line pl-6">
              <p className="text-ui font-medium">{c.title}</p>
              <p className="mt-1.5 max-w-[14rem] text-[0.68rem] text-stone">{c.body}</p>
              {c.href === "#community" ? <div id="community" className="mt-8 md:mt-auto"><Socials /></div> : <a href={c.href} className="link-underline mt-8 flex w-fit items-center gap-2 text-ui md:mt-auto">
                {c.link}
                <span className="grid h-3.5 w-3.5 place-items-center rounded-[4px] bg-lichen text-[0.5rem] text-white">↗</span>
              </a>}
            </div>
          ))}
        </div>
        <div className="relative -mx-5 mt-10 md:-mx-10">
          <img
            src="/media/shore.webp"
            alt="Granite slabs and still water along a mountain lakeshore"
            className="block h-[clamp(260px,42vw,560px)] w-full object-cover object-bottom [mask-image:linear-gradient(to_bottom,transparent_0%,black_45%)]"
          />
          <div className="absolute inset-x-0 bottom-0 flex flex-wrap justify-between gap-2 px-5 pb-4 font-mono text-[0.6rem] text-white/85 uppercase md:px-10">
            <span>{footer.note}</span>
            <span>{footer.year} Overdrive</span>
          </div>
        </div>
      </footer>
    </>
  );
}
