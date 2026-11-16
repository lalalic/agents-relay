/*
 * Small standalone flowchart renderer for the ORIGINAL Agents Relay Dashboard.
 * The original HTML/CSS/event handlers are unchanged. Canonical graph sources
 * remain authoritative and are never interpreted as executable commands.
 */
(function(){
'use strict';
function esc(s){return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;')
 .replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;')}
const states=new Map();
function add(name){if(!states.has(name))states.set(name,true)}
function renderSync(id,source){
 states.clear();
 const labels=new Map(),edges=[];
 for(const raw of source.split(/\r?\n/)){
   const line=raw.trim();
   if(!line||/^(%%|style |class |classDef |click |subgraph )/.test(line))continue;
   const defs=/\b([a-zA-Z][a-zA-Z_0-9]*)\s*(?:\["([^"\n]*)"\]|\{"([^"\n]*)"\}|\[([^\]\n]*)\]|\(([^)\n]*)\))/g;
   for(const m of line.matchAll(defs)){
     add(m[1]);labels.set(m[1],m[2]||m[3]||m[4]||m[5]||m[1]);
   }
   const arcs=/\b([a-zA-Z][a-zA-Z_0-9]*)\s*(?:-->|-.->|==>)\s*(?:\|[^|]*\|\s*)?\b([a-zA-Z][a-zA-Z_0-9]*)\b/g;
   for(const m of line.matchAll(arcs)){add(m[1]);add(m[2]);edges.push([m[1],m[2]])}
 }
 const names=[...states.keys()];
 if(!names.length)return {svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 650 90" width="650" height="90"><text x="12" y="38" fill="#8fa3ba" font-family="sans-serif" font-size="12">No flowchart nodes. View canonical source.</text></svg>'};
 const cols=4,cw=248,ch=103,w=cols*cw+28,h=Math.ceil(names.length/cols)*ch+30;
 const points=new Map();
 names.forEach((name,i)=>points.set(name,{x:16+(i%cols)*cw,y:20+Math.floor(i/cols)*ch}));
 let svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+w+' '+h+'" width="'+w+'" height="'+h+'">';
 svg+='<defs><marker id="rust-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#6983a1"/></marker></defs>';
 for(const [a,b] of edges){
   const p=points.get(a),q=points.get(b);if(!p||!q)continue;
   const x=p.x+111,y=p.y+52,u=q.x+111,v=q.y+14;
   svg+='<path d="M'+x+' '+y+' Q'+((x+u)/2)+' '+((y+v)/2-25)+' '+u+' '+v+'" fill="none" stroke="#718aa5" stroke-width="1.2" marker-end="url(#rust-arrow)" opacity=".55"/>';
 }
 for(const [i,name] of names.entries()){
   const p=points.get(name),label=labels.get(name)||name;
   const short=label.length>35?label.slice(0,33)+'…':label;
   svg+='<g class="node default" id="diagram-flowchart-'+esc(name)+'-'+i+'">';
   svg+='<rect class="basic label-container" x="'+p.x+'" y="'+p.y+'" width="222" height="62" rx="9" ry="9" fill="#f9fbff" stroke="#657f9e"/>';
   svg+='<text x="'+(p.x+12)+'" y="'+(p.y+25)+'" font-family="sans-serif" font-size="12" fill="#182536">'+esc(short)+'</text>';
   svg+='<text x="'+(p.x+12)+'" y="'+(p.y+46)+'" font-family="sans-serif" font-size="10" fill="#63809d">'+esc(name)+'</text>';
   svg+='</g>';
 }
 svg+='</svg>';
 return {svg};
}
window.mermaid={initialize(){},renderSync,render(id,source){return Promise.resolve(renderSync(id,source));}};
})();
