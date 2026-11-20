// Build-time pre-render: writes each public route's real text into static HTML so
// crawlers and no-JS readers see the page, then the React app hydrates on top.
// Runs after `vite build` and `vite build --ssr`; no server is needed at runtime.
import {readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(web, 'dist');
const ssr = join(web, 'dist-ssr');
export const SITE = 'https://get-overdrive.com';

// One entry per public route. `file` is served by Vercel cleanUrls (/dashboard -> dashboard.html).
export const ROUTES = [
  {
    path: '/',
    file: 'index.html',
    title: 'Overdrive - Pick a gear',
    description: "Pick a gear. Hold the token. Explore Overdrive's geared stock and crypto tokens on Robinhood Chain.",
    canonical: '/',
  },
  {
    path: '/how-it-works',
    file: 'how-it-works.html',
    title: 'How Overdrive works - gears, the daily toll and exits',
    description:
      'A gear is an ERC-20 token whose value follows the price raised to a power. Fully paid, holders are never liquidated, and the cost is a daily toll.',
    // Same page body as the home page, so the home page stays the canonical copy.
    canonical: '/',
  },
  {
    path: '/dashboard',
    file: 'dashboard.html',
    title: 'Overdrive dashboard - markets, gears and trade',
    description: 'Browse the launch markets, compare the Cruise and Sport gears, and quote a trade on Robinhood Chain.',
    canonical: '/dashboard',
  },
  {
    path: '/roadmap',
    file: 'roadmap.html',
    title: 'Overdrive roadmap - the first 48 hours of updates',
    description: 'The 24 launch updates in release order. An item shows LIVE only when its changelog entry exists. Nothing else is promised past update 24.',
    canonical: '/roadmap',
  },
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function headFor(route) {
  const url = SITE + (route.path === '/' ? '/' : route.path);
  const image = `${SITE}/overdrive-banner.png`;
  return [
    `<title>${esc(route.title)}</title>`,
    `<meta name="description" content="${esc(route.description)}"/>`,
    `<link rel="canonical" href="${SITE}${route.canonical}"/>`,
    `<meta property="og:type" content="website"/>`,
    `<meta property="og:site_name" content="Overdrive"/>`,
    `<meta property="og:title" content="${esc(route.title)}"/>`,
    `<meta property="og:description" content="${esc(route.description)}"/>`,
    `<meta property="og:url" content="${url}"/>`,
    `<meta property="og:image" content="${image}"/>`,
    `<meta name="twitter:card" content="summary_large_image"/>`,
    `<meta name="twitter:title" content="${esc(route.title)}"/>`,
    `<meta name="twitter:description" content="${esc(route.description)}"/>`,
    `<meta name="twitter:image" content="${image}"/>`,
  ].join('');
}

export function page(template, route, body) {
  const head = template
    .replace(/<title>[^<]*<\/title>/, '')
    .replace(/<meta name="description" content="[^"]*"\s*\/?>/, '')
    .replace('</head>', `${headFor(route)}</head>`);
  if (!head.includes('<div id="root"></div>')) throw new Error('index.html has no empty #root');
  return head.replace('<div id="root"></div>', `<div id="root">${body}</div>`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const template = readFileSync(join(dist, 'index.html'), 'utf8');
  const {render} = await import(pathToFileURL(join(ssr, 'entry-server.js')).href);
  for (const route of ROUTES) {
    const html = page(template, route, render(route.path));
    writeFileSync(join(dist, route.file), html);
    console.log(`prerender ${route.path} -> dist/${route.file} (${html.length} bytes)`);
  }
  rmSync(ssr, {recursive: true, force: true});
}
