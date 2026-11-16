import {StrictMode} from 'react';
import {renderToString} from 'react-dom/server';
import App, {routeFor} from './App';

// Build-time only: scripts/prerender.mjs calls this once per public route.
export function render(pathname: string): string {
  return renderToString(<StrictMode><App initialPath={routeFor(pathname)} /></StrictMode>);
}
