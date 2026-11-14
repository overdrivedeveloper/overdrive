import {useReveals} from '../hooks/useReveals';
import './overdrive-extras.css';
import './freedom-motion.css';

const risks = [
  {title:'Market moves cut both ways.', body:'Geared token value can fall toward zero. Sport loses about 19% on a 10% underlying fall, before costs.'},
  {title:'Time has a cost.', body:'The daily toll accumulates even when the underlying price goes nowhere.'},
  {title:'Stock feeds have market hours.', body:'Prices can pause overnight, on weekends, or when a feed is interrupted.'},
  {title:'The Governor can lose.', body:'Violent unhedged moves can cause losses. Caps and insurance cannot remove every risk.'},
  {title:'Audit status matters.', body:'The protocol is unaudited until its audit milestone is complete. Review the status before committing funds.'},
];
const safeguards = [
  {title:'No holder liquidation.', body:'Fully paid ERC-20s have no holder margin calls. Backers have separate collateral rules and can be liquidated.'},
  {title:'A published toll formula.', body:'Review the quoted daily toll before buying. Eco usually receives toll; your token balance stays unchanged.'},
  {title:'Fresh-price guards.', body:'Stale-price buys are blocked. Sell at the lower of last and live-pool value, or queue for a fresh feed.'},
  {title:'A separate exit reserve.', body:'The Governor nets and hedges exposure. Ring-fenced USDG, caps and insurance are intended to limit risk.'},
  {title:'Limits before expansion.', body:'Availability expands in phases. Parameter changes wait 48 hours; the guardian can only reduce risk immediately.'},
];
const stages = [
  ['Sport & Cruise', 'ETH, BTC, NVDA, TSLA and SPY; the Governor and exit reserve come first.'],
  ['Eco & Reverse', 'The remaining mega-caps, plus weekend and stock-split handling.'],
  ['Race & pairs', 'Race on SPY / QQQ at volatility up to 40%, and the three Sport pair gears.'],
  ['Retail favourites', 'HOOD, COIN, MSTR and PLTR, with tighter open-value caps.'],
  ['Open participation', 'Backer access, agent access and router allowlisting.'],
];
function StatusIcon({positive}:{positive:boolean}) {
  return <svg className="freedom-status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">{positive?<><circle cx="12" cy="12" r="9"/><path d="m7.5 12 3 3 6-6" strokeLinecap="round" strokeLinejoin="round"/></>:<><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6" strokeLinecap="round"/></>}</svg>;
}
/** The supplied three-column FreedomSection, using Overdrive's risk disclosures. */
export function FreedomSection() {
  const reveal = useReveals<HTMLElement>();
  return <section ref={reveal} id="risks" className="freedom-section" aria-labelledby="freedom-heading">
    <header className="freedom-header" data-reveal="freedom"><span className="freedom-badge"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="m10 2 6.5 2.5V10c0 4-6.5 8-6.5 8S3.5 14 3.5 10V4.5L10 2Z"/><path d="m6.5 9.5 2.5 2.5 4.5-4.5"/></svg>Risk & safeguards</span><h2 id="freedom-heading">Know what you hold.<br/><span>Understand the limits.</span></h2></header>
    <div className="freedom-grid">
      <div className="freedom-column freedom-risks"><h3 data-reveal="freedom">The risks</h3>{risks.map(r=><article key={r.title} className="freedom-card" data-reveal="freedom"><StatusIcon positive={false}/><div><h4>{r.title}</h4><p>{r.body}</p></div></article>)}</div>
      <div className="freedom-center" data-reveal="freedom"><div className="freedom-circle"><img src="/media/stones.webp" alt="" loading="lazy" decoding="async"/><div className="freedom-circle-shade"/><span className="freedom-circle-sweep" aria-hidden="true"/><div className="freedom-circle-copy"><span>FULLY PAID</span><strong>ERC-20</strong><p>Your token.<br/>Your exposure.</p></div></div><p className="freedom-center-note">Safeguards limit risk.<br/>They do not prevent losses.</p></div>
      <div className="freedom-column freedom-safeguards"><h3 data-reveal="freedom">The safeguards</h3>{safeguards.map(r=><article key={r.title} className="freedom-card" data-reveal="freedom"><StatusIcon positive/><div><h4>{r.title}</h4><p>{r.body}</p></div></article>)}</div>
    </div>
    <details id="rollout" className="freedom-rollout" data-reveal="freedom"><summary><span><small>Phased availability</small><strong>The rollout plan</strong></span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m7 10 5 5 5-5" strokeLinecap="round" strokeLinejoin="round"/></svg></summary><p className="freedom-rollout-note">Planned sequence, without launch dates. A listed market or gear is not a statement that it is open for trading.</p><ol>{stages.map(([title,body],i)=><li key={title}><span>0{i+1}</span><div><h4>{title}</h4><p>{body}</p></div></li>)}</ol></details>
  </section>;
}
