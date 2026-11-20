// Public Overdrive product content. Return examples are before daily toll and trading costs.
export const nav = {
  brand: 'OVERDRIVE',
  links: ['Overview', 'Gears', 'Markets', 'Details', 'Mechanics', 'Risks & rollout'],
  lang: 'English',
  request: 'Explore gears',
  cta: 'Open app',
};
export const hero = {
  eyebrow: 'Stocks, shifted into a higher gear',
  lineA: 'Pick a gear,',
  lineB: 'hold the token',
  sub: 'Overdrive turns stocks and crypto into geared tokens. Choose your exposure and hold it in your wallet - with no liquidation for holders.',
  scroll: 'Scroll to explore',
};
export const dashboard = {
  workspace: 'Overdrive', plan: 'Geared token', user: 'TSLA · Tesla', role: 'Market explorer',
  nav: [
    {label: 'Overview', active: true}, {label: 'Markets'}, {label: 'Your gears'},
    {label: 'Gear family', open: true, children: ['Cruise', 'Sport', 'Race · Coming soon', 'Eco · Coming soon', 'Reverse · Coming soon']},
    {label: 'The Governor'},
  ],
  range: 'Underlying move · +10%', date: 'Before costs', netLabel: 'Sport · token response',
  net: 21, netFrom: 0, delta: 'Power 2',
  holdings: [
    {label: 'Cruise', value: 15.4, dot: '#c7c7c9'},
    {label: 'Sport', value: 21, dot: '#d8473d'},
  ],
  stats: [{label: 'Settlement', value: 'USDG'}, {label: 'Token', value: 'ERC-20'}],
  tabs: ['Cruise', 'Sport'],
  rows: [
    {name: 'TSLA-CRUISE', kind: 'Cruise', value: '+15.4%', change: '−14.6%'},
    {name: 'TSLA-SPORT', kind: 'Sport', value: '+21.0%', change: '−19.0%'},
  ],
};
export const features = {
  eyebrow: 'The Overdrive idea', title: ['Familiar markets.', 'A different gear.'],
  aside: 'Choose how you move with stocks and crypto - from a measured Cruise to a stronger Sport, held as a token in your wallet.',
  items: [
    {n: '01', title: 'Choose your exposure', body: 'Two gears at launch, Cruise and Sport. Race, Eco and Reverse are coming soon. Availability and limits are set for each market.'},
    {n: '02', title: 'Know what moves you', body: 'Sport gains about 21% on a 10% rise, and loses about 19% on a 10% fall. Both figures are before toll and costs.'},
    {n: '03', title: 'One clear fee split', body: 'Protocol fees support the Governor and exit reserve, the treasury, slashable staking capital and token burns.'},
  ],
};
export const featureCards = {
  worth: {
    title: 'Gear response · +10% move',
    figures: [{label: 'Cruise', value: '+15.4%'}, {label: 'Sport', value: '+21%'}],
    bars: [0.36,0.40,0.44,0.48,0.53,0.58,0.63,0.69,0.75,0.82,0.90],
    rows: [{label: 'Cruise power', value: '1.5'}, {label: 'Sport power', value: '2'}],
  },
  returns: {
    title: 'TSLA-SPORT · +10% move', figure: 21,
    caption: 'Before daily toll and costs',
    body: 'A 10% rise in TSLA means approximately a 21% rise in TSLA-SPORT. The gear cuts both ways.',
    stats: [{label: 'TSLA drops', value: '−10%'}, {label: 'Sport falls', value: '−19%'}, {label: 'Toll', value: 'Daily'}],
  },
  drift: {
    title: 'Protocol fee allocation', figure: 80, caption: 'Protocol operations',
    slices: [{label: 'Operations',pct:80,color:'#f2c4bf'},{label:'Treasury',pct:10,color:'#d8473d'},{label:'Stakers',pct:5,color:'#bcbcc1'},{label:'Burned',pct:5,color:'rgba(255,255,255,0.45)'}],
  },
};
export const signal = {
  chipValue:15.4, chipLabel:'Cruise · on a +10% market move', chipAction:'Explore the gears',
  cardTitle:'Cruise · before toll and costs', score:15.4,
  points:[0.12,0.17,0.23,0.29,0.35,0.42,0.49,0.56,0.64,0.72,0.80,0.89],
  actions:['Hold a fully paid ERC-20','No liquidation for holders','Daily toll changes token value','Your token balance stays the same'],
  alertTitle:'Gears cut both ways', alertBody:'A 10% market fall means about a 14.6% Cruise fall, before toll and costs.',
};
export const layers = {
  titleA:'One risk book.', titleB:'Every gear connected.', core:'The Governor',
  coreNote:['The protocol’s house book','Exposure across every gear','A ring-fenced exit reserve'],
  nodes:[{id:'cruise',label:'Cruise · 1.5',x:0.12,y:0.5},{id:'sport',label:'Sport · 2',x:0.86,y:0.2},{id:'race',label:'Race · Coming soon',x:0.88,y:0.78},{id:'eco',label:'Eco · Coming soon',x:0.3,y:0.86},{id:'reverse',label:'Reverse · Coming soon',x:0.3,y:0.14}],
  eyebrow:'Under the hood', capsTitle:['Built for every','side of the market'],
  caps:[
    {title:'One connected book',body:'Gears offset each other inside one book. The Governor can also offset what remains on an outside venue once that is switched on; the dashboard shows whether it is. Race, Eco and Reverse are coming soon.'},
    {title:'A daily toll',body:'A published formula adjusts token value. Your balance stays the same.'},
    {title:'An exit reserve',body:'USDG is ring-fenced for holder exits. When prices pause, sells use the lower price or queue for a fresh feed.'},
  ],
};
export const integrations = {
  eyebrow:'The market family',title:['The names you know.', 'More ways to hold them.'],pill:'Overdrive',pillNote:'one family',
  caption:'Stocks. Index ETFs. Crypto. Pair gears.',
  body:'At launch: ETH, BTC, NVDA, TSLA and SPY. More mega-caps, retail favourites, QQQ and pair gears are coming later, each only once it is listed on chain. Crypto runs 24/7; equity feeds follow their market sessions.',
  marks:['NVDA','TSLA','AAPL','MSFT','META','AMZN','MSTR','SPY','QQQ','ETH','BTC'],
};
export const compare = {
  eyebrow:'Know your role',title:['Hold a geared token.', 'Understand the other side.'],
  body:'Holders buy fully paid tokens. Backers supply collateral and take the other side. Different roles, different risks - in the same system.',
  head:'How it works',ours:'Holders',theirs:'Backers',
  rows:[
    {label:'Keep tokens in a wallet',ours:'Yes',theirs:'Mint & sell'},
    {label:'Post extra collateral',ours:'No',theirs:'Required'},
    {label:'Can be liquidated',ours:'Never',theirs:'Yes'},
    {label:'Exposure to token price',ours:'Yes',theirs:'Yes'},
    {label:'Toll on paying gears',ours:'Pay',theirs:'Collect'},
  ],
  costLabel:'Know the risk',costNote:'Daily toll applies to holders',oursCost:'Value can fall',theirsCost:'Collateral at risk',
};
export const cta = {
  eyebrow:'Your next move',lineA:['Pick','your','gear'],lineB:['hold','the','token'],
  body:'From Cruise to Sport, find the exposure that matches your view. Holders are never liquidated, but token value can fall towards zero.',
  request:'Explore the gears',open:'Open app',feedTitle:'The Overdrive essentials',
  feed:[
    {title:'Two gears at launch',body:'Cruise · Sport. Race, Eco and Reverse are coming soon.'},
    {title:'Fully paid tokens',body:'No liquidation for holders'},
    {title:'A daily toll',body:'Shown before you buy a gear'},
    {title:'USDG settlement',body:'Built on Robinhood Chain'},
    {title:'Stocks and crypto',body:'One family of geared ERC-20s'},
    {title:'Know your exposure',body:'Geared token values can fall towards zero'},
  ],
};
export const footer = {
  titleA:'The next move',titleB:'is yours.',body:'Pick your market. Choose your gear. Hold the token.',
  cols:[
    {title:'Explore Overdrive',body:'Compare markets and gears, understand the toll, and see how your exposure changes.',link:'Open the app',href:'/dashboard'},
    {title:'Keep in touch',body:'Follow Overdrive across our community channels.',link:'GitHub · Telegram · X',href:'#community'},
  ],
  note:'Holders are never liquidated. Value can fall towards zero.',year:'© 2026',
};
