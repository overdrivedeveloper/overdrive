import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {readFileSync} from 'node:fs';
import {defineConfig} from 'vite';
import {liveIds} from './src/lib/roadmap';

// The /roadmap page marks an item LIVE only when its entry is in the public CHANGELOG.md, read here at build time.
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {__ROADMAP_LIVE__: JSON.stringify(liveIds(changelog))},
  // The wallet flow reads the committed deployment files in ../app/deployments.
  server: {fs: {allow: ['..']}},
});
