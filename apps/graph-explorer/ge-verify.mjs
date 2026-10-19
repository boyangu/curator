const base='http://localhost:9235';
const t=await (await fetch(`${base}/json/new?http://localhost:5180/`,{method:'PUT'})).json();
const ws=new WebSocket(t.webSocketDebuggerUrl);
let id=0;const pending=new Map();const logs=[];
const send=(m,p={})=>new Promise(r=>{const i=++id;pending.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}));});
ws.onmessage=(m)=>{const d=JSON.parse(m.data);if(d.id&&pending.has(d.id)){pending.get(d.id)(d.result);pending.delete(d.id);}if(d.method==='Runtime.exceptionThrown')logs.push('[EXC] '+(d.params.exceptionDetails.exception?.description??d.params.exceptionDetails.text));};
await new Promise(r=>ws.onopen=r);
await send('Runtime.enable');
await new Promise(r=>setTimeout(r,5000));
const counts=await send('Runtime.evaluate',{expression:`JSON.stringify({counts:[...document.querySelectorAll('.toggle .count')].map(e=>e.textContent),total:document.querySelector('.total')?.textContent})`,returnByValue:true});
console.log('COUNTS', counts.result.value);
const search=async(q)=>{
  await send('Runtime.evaluate',{expression:`(()=>{const s=document.querySelector('.search');s.value=${JSON.stringify(q)};s.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`});
  await new Promise(r=>setTimeout(r,400));
  const st=await send('Runtime.evaluate',{expression:`document.getElementById('status').textContent`,returnByValue:true});
  console.log(`search ${JSON.stringify(q)} -> status: ${JSON.stringify(st.result.value)}`);
};
await search('Keinemusik');      // split-out member: should be FOUND (no "No node")
await search('&ME');             // & preserved, not split: should be FOUND
await search('Rampa, Adam Port, &ME, Keinemusik'); // raw combined: should NOT exist
console.log('EXC:', logs.length?logs:'none');
ws.close();
