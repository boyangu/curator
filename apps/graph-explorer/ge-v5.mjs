const base='http://localhost:9238';
const t=await (await fetch(`${base}/json/new?http://localhost:5180/`,{method:'PUT'})).json();
const ws=new WebSocket(t.webSocketDebuggerUrl);
let id=0;const pending=new Map();const logs=[];
const send=(m,p={})=>new Promise(r=>{const i=++id;pending.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}));});
ws.onmessage=(m)=>{const d=JSON.parse(m.data);if(d.id&&pending.has(d.id)){pending.get(d.id)(d.result);pending.delete(d.id);}if(d.method==='Runtime.exceptionThrown')logs.push('[EXC] '+(d.params.exceptionDetails.exception?.description??d.params.exceptionDetails.text));};
const evl=async(e)=>(await send('Runtime.evaluate',{expression:e,returnByValue:true})).result.value;
await new Promise(r=>ws.onopen=r); await send('Runtime.enable');
// Sample a node's position over time to detect when motion stops.
const sampleX = `(()=>{const c=document.querySelector('#sigma canvas');return c?1:0;})()`;
await new Promise(r=>setTimeout(r,3000));
for (let i=0;i<10;i++){
  // read whether convergeTimer cleared by checking movement of first node label position via sigma graph isn't exposed; instead measure CPU proxy: compare two quick position reads is impossible from DOM.
  await new Promise(r=>setTimeout(r,1500));
}
console.log('canvas present:', await evl(sampleX));
console.log('EXC:', logs.length?logs:'none');
ws.close();
