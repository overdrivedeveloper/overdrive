import type {MouseEvent} from 'react';
import {useReducedMotion} from '../hooks/useReducedMotion';
import {Features} from './Features';
import {Signal} from './Signal';
import {Layers} from './Layers';
import {Integrations} from './Integrations';
import {Compare} from './Compare';
import {Closing} from './Closing';
import {Mechanics} from './Mechanics';
import {FreedomSection} from './FreedomSection';
import '../landing-brand.css';

/** The complete Tarn section sequence, with Overdrive content and palette. */
export function OverdriveLanding({navigate}: {navigate:(path:string)=>void}) {
  const reduced = useReducedMotion();
  function routeClick(event: MouseEvent<HTMLDivElement>) {
    const link = (event.target as HTMLElement).closest('a');
    if(link?.getAttribute('href') === '/dashboard' && !event.metaKey && !event.ctrlKey && !event.shiftKey && event.button === 0) {
      event.preventDefault(); navigate('/dashboard');
    }
  }
  return <div className="tarn-landing" onClick={routeClick}>
    <Features />
    <Signal reduced={reduced} />
    <Layers reduced={reduced} />
    <Integrations reduced={reduced} />
    <Compare reduced={reduced} />
    <Mechanics />
    <FreedomSection />
    <Closing reduced={reduced} />
  </div>;
}
