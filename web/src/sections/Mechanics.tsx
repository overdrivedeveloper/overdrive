import {MarketMark} from '../components/MarketMark';
import {dailyTollPercent} from '../lib/overdrive';
import {useReveals} from '../hooks/useReveals';
import './overdrive-extras.css';
import './mechanics-motion.css';

const check = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m5 12 4 4 10-10" strokeLinecap="round" strokeLinejoin="round"/></svg>;
const arrow = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round"/></svg>;
const toll = dailyTollPercent('Sport', 60);
const tollDays = [1, 5, 10, 15, 20, 25, 30];
const reductions = tollDays.map(day => (1 - Math.pow(1 - toll / 100, day)) * 100);

/** Five-panel mosaic adapted from the supplied product-mosaic reference. */
export function Mechanics() {
  const ref = useReveals<HTMLElement>();
  return <section ref={ref} id="mechanics" className="mechanics-section" aria-labelledby="mechanics-heading">
    <header className="extras-section-heading" data-reveal="mosaic-heading">
      <span className="extras-eyebrow">The mechanics</span>
      <h2 id="mechanics-heading">What happens<br/><span>when you shift.</span></h2>
    </header>
    <div className="mechanics-stage" aria-label="How Overdrive works">
      <article className="mechanics-card mechanics-utility" data-reveal="mosaic" aria-label="Token utility">
        <div className="mechanics-toast-ledge" aria-hidden="true"/>
        <div className="mechanics-toast">
          <span className="mechanics-utility-icon">{check}</span>
          <div><h3>A token, with a purpose.</h3><p>Coming later: stake for fee discounts<br/>and vote weight on markets and caps.</p></div>
          <span className="mechanics-ticker">UTILITY</span>
        </div>
        <p className="mechanics-utility-note">Slashable first-loss capital. No revenue claim.</p>
      </article>

      <article className="mechanics-card mechanics-pairs" data-reveal="mosaic">
        <div className="mechanics-pairs-copy"><span className="extras-kicker">Pair gears · Coming later</span><h3>One name<br/>against another.</h3><p>Sport on a price ratio.<br/>Your view on which one leads.</p></div>
        <div className="mechanics-pair-stack">
          <div className="mechanics-pair-chip"><span>NVDA / AMD</span><MarketMark symbol="NVDA/AMD" size={30} decorative/></div>
          <div className="mechanics-pair-chip"><span>QQQ / SPY</span><MarketMark symbol="QQQ/SPY" size={30} decorative/></div>
          <span className="mechanics-pair-badge">SPORT · POWER 2</span>
        </div>
      </article>

      <article className="mechanics-card mechanics-trade" data-reveal="mosaic">
        <div className="mechanics-trade-copy"><h3><span>Buy a gear.</span><br/>Hold your view.</h3><p>USDG in. A fully paid ERC-20 in your wallet. Buy and sell through the Governor’s Uniswap v4 pool.</p><div className="mechanics-spreads"><b>Starting spreads</b><span>Crypto 0.4% · ETFs 0.5% · Mega-caps 0.6%<br/>Pairs 0.8% · Retail favourites 1.0%</span></div></div>
        <div className="mechanics-illustration" aria-label="Buy with USDG, hold the geared token, sell back to USDG">
          <div className="mechanics-window mechanics-window-back"><div className="mechanics-window-bar"><i/><i/><i/></div><div className="mechanics-window-body"><span className="mechanics-step">01 / BUY</span><b>USDG<br/><span>→ Geared token</span></b><small>Value, plus the quoted spread.</small></div></div>
          <div className="mechanics-window mechanics-window-front"><div className="mechanics-window-bar"><i/><i/><i/></div><div className="mechanics-window-body"><span className="mechanics-step">02 / HOLD</span><b>Your balance<br/><span>stays the same.</span></b><small>The daily toll changes token value.</small></div></div>
          <div className="mechanics-sell-pill"><span>{check}</span>03 / SELL · BACK TO USDG</div>
          <div className="mechanics-wallet-pill"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="6" width="18" height="15" rx="3"/><path d="M3 9V6a2 2 0 0 1 2-2h12v2m4 6h-6v5h6"/><circle cx="17" cy="14.5" r=".7" fill="currentColor"/></svg><span>YOUR WALLET<br/><b>YOUR TOKEN</b></span></div>
          <svg className="mechanics-cursor" viewBox="0 0 24 28" fill="none" aria-hidden="true"><path d="m3 2 18 16-8 .4-4.6 7.4L3 2Z" fill="#fff" stroke="#292525" strokeWidth="1.3"/></svg>
        </div>
      </article>

      <article className="mechanics-card mechanics-toll" data-reveal="mosaic">
        <span className="mechanics-toll-tag">The daily toll</span><h3>{toll.toFixed(3)}<span>% / day</span></h3><p className="mechanics-toll-sub">A worked example, not a fixed rate.</p>
        <div className="mechanics-toll-chart" role="img" aria-label={`Illustrative token-value reduction from the toll with a flat underlying: ${tollDays.map((d,i)=>`${d} days, ${reductions[i].toFixed(2)} percent`).join('; ')}`}>
          {tollDays.map((day,i)=><div key={day}><div className="mechanics-toll-track"><div className={`mechanics-toll-bar ${i===6?'is-last':''}`} style={{height:`${reductions[i]/reductions[6]*100}%`}}><b>{reductions[i].toFixed(2)}<span>%</span></b></div></div><small>{day}d</small></div>)}
        </div>
        <p className="mechanics-chart-caption">TSLA Sport · 60% annual volatility · flat price. Value reduction from the formula component only; usage and spreads excluded.</p>
      </article>

      <article className="mechanics-card mechanics-availability" data-reveal="mosaic">
        <div><h3>Know the cost.<br/>Check availability.</h3><p>Spreads widen off-hours. Gears open in stages and remain subject to market caps and fresh prices.</p></div>
        <a href="/dashboard" className="mechanics-catalog-link"><span className="mechanics-search-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg></span><span>Explore the market catalog</span>{arrow}</a>
      </article>
    </div>
  </section>;
}
