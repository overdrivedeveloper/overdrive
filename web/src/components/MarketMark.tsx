import type { CSSProperties } from 'react';
import './MarketMark.css';

/** Exact company/asset silhouettes, recolored through CSS; provenance lives in /marks/sources.json. */
const MARKS: Record<string, string> = {
  TSLA: 'Tesla', NVDA: 'NVIDIA', AAPL: 'Apple', MSFT: 'Microsoft', META: 'Meta',
  AMZN: 'Amazon', HOOD: 'Robinhood', COIN: 'Coinbase', MSTR: 'Strategy', PLTR: 'Palantir',
  SPY: 'SPDR', QQQ: 'Invesco', ETH: 'Ethereum', BTC: 'Bitcoin', AMD: 'AMD',
};

export type MarketMarkProps = {
  symbol: string;
  size?: number;
  tone?: 'silver' | 'coral' | 'dark';
  className?: string;
  decorative?: boolean;
};

export function MarketMark({ symbol, size = 36, tone = 'silver', className = '', decorative = false }: MarketMarkProps) {
  const symbols = symbol.toUpperCase().split('/').slice(0, 2);
  const names = symbols.map(key => MARKS[key] || key);
  const style = { '--market-mark-size': `${size}px` } as CSSProperties;

  if (symbols.length > 1) {
    return <span className={`market-mark-pair ${className}`} style={style} role={decorative ? undefined : 'img'} aria-label={decorative ? undefined : names.join(' / ')} aria-hidden={decorative || undefined}>
      {symbols.map((key, index) => <MarketMark key={`${key}-${index}`} symbol={key} size={size * 0.76} tone={index ? 'dark' : tone} decorative />)}
    </span>;
  }

  const key = symbols[0];
  const hasMark = key in MARKS;
  return <span
    className={`market-mark ${className}`}
    style={style}
    data-tone={tone}
    data-symbol={key}
    role={decorative ? undefined : 'img'}
    aria-label={decorative ? undefined : `${names[0]} logo`}
    aria-hidden={decorative || undefined}
  >
    {hasMark ? <span className="market-mark__shape" style={{ '--market-mark-src': `url("/marks/${key.toLowerCase()}.svg")` } as CSSProperties} /> : <svg className="market-mark__unknown" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3 21 12 12 21 3 12Z" stroke="currentColor" strokeWidth="1.5" /><path d="M7 12h10M12 7v10" stroke="currentColor" strokeWidth="1.5" /></svg>}
  </span>;
}

export default MarketMark;
