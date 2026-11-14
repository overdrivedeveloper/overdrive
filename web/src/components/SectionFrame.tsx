import {useEffect, useRef, useState, type ReactNode} from 'react';
import './SectionFrame.css';
export default function SectionFrame({children}:{children:ReactNode}){
 const ref=useRef<HTMLElement>(null);const [scale,setScale]=useState(1);const [compact,setCompact]=useState(()=>window.innerWidth<1180);
 useEffect(()=>{const el=ref.current;if(!el)return;const fit=()=>{setCompact(window.innerWidth<1180);setScale(el.getBoundingClientRect().width/1600)};fit();const ro=new ResizeObserver(fit);ro.observe(el);window.addEventListener('resize',fit);return()=>{ro.disconnect();window.removeEventListener('resize',fit)}},[]);
 return <main className={`frame od-frame ${compact?'is-compact':''}`} ref={ref}><div className="frame__canvas" style={compact?undefined:{width:1600,height:900,transform:`scale(${scale})`}}>{children}</div></main>
}
