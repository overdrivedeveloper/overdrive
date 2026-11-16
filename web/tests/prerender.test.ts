import {describe, expect, test} from 'bun:test';
import {existsSync, readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';

// The built HTML (read without running any JavaScript, as a crawler does) must hold each
// public route's real text and its own head tags. CI builds before testing; a bare
// `bun test` builds once here so the check never passes on a missing dist/.
const WEB = join(import.meta.dir, '..');
const DIST = join(WEB, 'dist');
if (!existsSync(join(DIST, 'dashboard.html'))) {
  const r = spawnSync('npm', ['run', 'build'], {cwd: WEB, stdio: 'ignore'});
  if (r.status !== 0) throw new Error('npm run build failed');
}

// The same word count the launch-visible check uses: drop scripts and styles, then tags.
const text = (html: string) =>
  html
    .replace(/<script.*?<\/script>|<style.*?<\/style>/gs, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;| /g, ' ')
    .replace(/\s+/g, ' ');
const words = (html: string) => text(html).trim().split(' ').length;
const read = (file: string) => readFileSync(join(DIST, file), 'utf8');

const PAGES = [
  {file: 'index.html', url: 'https://get-overdrive.com/', min: 800, copy: ['Pick a gear, hold the token', 'What happens when you shift.', 'Holders are never liquidated']},
  {file: 'how-it-works.html', url: 'https://get-overdrive.com/how-it-works', min: 800, copy: ['What happens when you shift.', 'Know what you hold.']},
  {file: 'dashboard.html', url: 'https://get-overdrive.com/dashboard', min: 150, copy: ['Pick a gear. Make your move.']},
];

describe('pre-rendered public routes', () => {
  for (const p of PAGES) {
    test(`${p.file} ships its text and head tags without JavaScript`, () => {
      const html = read(p.file);
      expect(words(html)).toBeGreaterThan(p.min);
      const body = text(html);
      for (const c of p.copy) expect(body).toContain(c);
      expect(html).not.toContain('<div id="root"></div>');
      expect(html.match(/<title>/g)?.length).toBe(1);
      expect(html.match(/<meta name="description"/g)?.length).toBe(1);
      expect(html).toContain(`<meta property="og:url" content="${p.url}"/>`);
      for (const tag of ['og:title', 'og:description', 'og:image', 'twitter:card']) expect(html).toContain(tag);
      expect(html).toContain('<link rel="canonical"');
      expect(html).toMatch(/<script type="module"[^>]*src="\/assets\//);
    });
  }

  test('each route has its own title and description', () => {
    const heads = PAGES.map((p) => read(p.file).match(/<title>.*?<\/title>.*?<meta name="description" content="[^"]*"/s)?.[0]);
    expect(new Set(heads).size).toBe(PAGES.length);
  });

  test('copy rules hold in the head tags (no em dashes)', () => {
    for (const p of PAGES) expect(read(p.file).match(/<head>.*<\/head>/s)?.[0]).not.toContain('\u2014');
  });

  test('Vercel serves the static files by clean URL', () => {
    const v = JSON.parse(readFileSync(join(WEB, 'vercel.json'), 'utf8'));
    expect(v.cleanUrls).toBe(true);
    expect(JSON.stringify(v.rewrites ?? [])).not.toContain('/index.html');
  });
});
