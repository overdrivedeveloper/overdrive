# Overdrive web

The complete supplied Tarn landing page and an Overdrive dashboard based on the supplied People Directory / PeopleNine source.

## Run

Use Node 22.12 or later, then run `npm ci` and `npm run dev`. `npm run build` creates a production build; `npm run lint` checks TypeScript. Configure production hosting to serve `index.html` for `/dashboard` and its query-string views.

## Interface

The landing page preserves Tarn’s seven original sections, photographs, composition and motion, with Overdrive content and palette. Two additional sections, Mechanics and Risks & rollout, use the latest supplied layouts to explain fees, pairs, tolls, safeguards and rollout stages. Both are linked from the navigation and animate as their panels enter view. Mechanics uses a layered mosaic entrance; Risks & rollout uses staggered cards, a circle reveal and a single coral light sweep. Reduced-motion preferences show the content immediately. Hover foliage uses coral and pink. Website copy uses regular hyphens in place of em dashes. Within the page, the hand logo appears only in the dashboard navigation. The same `public/overdrive-logo.png` is linked from `index.html` as the browser favicon and Apple home-screen icon.

Dashboard views: Dashboard, Markets, Portfolio, Trade, Backers, Governor, Activity and Token. Market search, filtering, sorting, watchlists, price response, toll calculations, collateral planning and preferences work locally. The original PeopleNine desktop geometry and class names are retained; tablet and phone layouts reflow into readable panels. Company and asset marks use real SVG geometry with the Overdrive palette; provenance is recorded in `public/marks/sources.json`.

## Connections

Injected EVM wallets can connect and switch to Robinhood Chain (4663). Wallet events update the interface. Account balances, quotes, vault opening, staking and trade execution require the actual protocol services and contracts. Missing data is shown as unavailable; no balances, orders or transactions are invented. No funds can be moved by this implementation.

Market caps in the catalog mean maximum protocol open value, not issuer market capitalization. Calculators use the supplied Overdrive price-power formula and published initial parameters, with costs and omitted terms identified alongside each result.

## Checks

TypeScript and production builds pass. Financial catalog/math checks cover all five powers, market eligibility, tolls and collateral thresholds. Browser checks cover the restored landing, desktop/mobile dashboard layouts, market search, gear selection, tab history, collateral math and navigation. Physical mobile devices and a connected live wallet have not been tested.
