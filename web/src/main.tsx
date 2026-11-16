import {StrictMode} from 'react';
import {createRoot, hydrateRoot} from 'react-dom/client';
import App, {routeFor} from './App';
import './index.css';

// The pinned stages depend on scroll position; always start at the top.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

const root = document.getElementById('root')!;
const path = routeFor(window.location.pathname);
// Landing routes ship pre-rendered HTML (scripts/prerender.mjs) and hydrate on top of it.
// The dashboard reads device storage and the URL in its first render, so it renders fresh
// over its static HTML (the static copy is for crawlers and no-JS readers).
if (root.hasChildNodes() && path === '/') {
  hydrateRoot(root, <StrictMode><App initialPath={path} /></StrictMode>);
} else {
  createRoot(root).render(<StrictMode><App /></StrictMode>);
}
