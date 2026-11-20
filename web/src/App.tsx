import {useCallback, useEffect, useLayoutEffect, useState} from 'react';
import {Nav} from './components/Nav';
import {Loader} from './components/Loader';
import {useReducedMotion} from './hooks/useReducedMotion';
import {startScroll} from './lib/scroll';
import {Hero} from './sections/Hero';
import {OverdriveLanding} from './sections/OverdriveLanding';
import {OverdriveDashboard} from './sections/OverdriveDashboard';
import {Roadmap} from './sections/Roadmap';
export function routeFor(pathname:string){return pathname.startsWith('/dashboard')?'/dashboard':/^\/roadmap\/?$/.test(pathname)?'/roadmap':'/'}
function currentPath(){return routeFor(window.location.pathname)}
// initialPath is set when the page was pre-rendered at build time (server render or hydration):
// the first render then matches the static HTML, and the loader check runs before the first paint.
export default function App({initialPath}:{initialPath?:string}){const [path,setPath]=useState(()=>initialPath??currentPath());const [loading,setLoading]=useState(()=>(initialPath??currentPath())!=='/roadmap'&&(initialPath!==undefined||!sessionStorage.getItem('overdrive-loaded')));
 useLayoutEffect(()=>{if(initialPath!==undefined&&sessionStorage.getItem('overdrive-loaded'))setLoading(false)},[initialPath]);const [transition,setTransition]=useState(false);const reduced=useReducedMotion();
 const finish=useCallback(()=>{sessionStorage.setItem('overdrive-loaded','1');setLoading(false)},[]);
 useEffect(()=>{const pop=()=>{const next=currentPath();if(next!==path){setPath(next);window.scrollTo(0,0)}};window.addEventListener('popstate',pop);return()=>window.removeEventListener('popstate',pop)},[path]);
 useEffect(()=>{if(path!=='/')return;return startScroll(reduced)},[path,reduced]);
 const navigate=(next:string)=>{if(next===path){window.scrollTo({top:0,behavior:'smooth'});return}setTransition(true);window.setTimeout(()=>{history.pushState({},'',next);setPath(next);window.scrollTo(0,0);setTransition(false)},reduced?0:160)};
 return <>{loading&&<Loader done={finish}/>}<div className={`route-content ${transition?'route-exit':''}`}>{path==='/'?<><Nav navigate={navigate}/><main><Hero reduced={reduced}/><OverdriveLanding navigate={navigate}/></main><div className="grain" aria-hidden/></>:path==='/roadmap'?<Roadmap navigate={navigate}/>:<OverdriveDashboard navigate={navigate}/>}</div></>
}
