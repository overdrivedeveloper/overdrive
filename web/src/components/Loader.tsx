import {useEffect, useState} from 'react';
const widths=[72,39,55,84,44,66,38,78,57,40,88,64,45,72,55,38];
export function Loader({done}: {done:()=>void}) {
 const [line,setLine]=useState(0);
 useEffect(()=>{const timer=window.setInterval(()=>setLine(v=>v+1),75);const end=window.setTimeout(done,650);return()=>{clearInterval(timer);clearTimeout(end)}},[done]);
 return <div className="loader-screen" aria-label="Loading Overdrive"><div className="loader-window"><div className="loader-head"><span><i/><i/><i/></span><small>SHIFTING INTO OVERDRIVE<span className="loader-cursor">_</span></small><span>↗</span></div><div className="loader-lines">{widths.map((width,i)=><div key={i} style={{opacity:i<line?1:0,marginLeft:i%4===1?'14px':0}}><b style={{width:`${width}px`}}/><b style={{width:`${width*.45}px`}}/><b style={{width:`${width*.25}px`}}/></div>)}</div></div></div>
}
