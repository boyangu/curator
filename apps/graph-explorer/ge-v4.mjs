const base='http://localhost:9237';
const t=await (await fetch(`${base}/json/new?http://localhost:5180/`,{method:'PUT'})).json();
const ws=new WebSocket(t.webSocketDebuggerUrl);
let id=0;const pending=new Map();const logs=[];
const send=(m,p={})=>new Promise(r=>{const i=++id;pending.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}));});
ws.onmessage=(m)=>{const d=JSON.parse(m.data);if(d.id&&pending.has(d.id)){pending.get(d.id)(d.result);pending.delete(d.id);}if(d.method==='Runtime.exceptionThrown')logs.push('[EXC] '+(d.params.exceptionDetails.exception?.description??d.params.exceptionDetails.text));};
const evl=async(e)=>(await send('Runtime.evaluate',{expression:e,returnByValue:true})).result.value;
await new Promise(r=>ws.onopen=r); await send('Runtime.enable');
await new Promise(r=>setTimeout(r,5000));
// pane[0] should now be Artists
console.log('pane order:', await evl(`JSON.stringify([...document.querySelectorAll('.filter-section .fs-title')].map(e=>e.textContent))`));
console.log('artist summary:', await evl(`document.querySelectorAll('.filter-section')[0].querySelector('.fs-summary').textContent`));
console.log('artist top rows:', await evl(`JSON.stringify([...document.querySelectorAll('.filter-section')[0].querySelectorAll('.fs-item')].slice(0,5).map(r=>r.querySelector('.fs-name').textContent+':'+r.querySelector('.fs-count').textContent))`));
console.log('total before:', await evl(`document.querySelector('.total').textContent`));
// set artist min>=5
await evl(`(()=>{const s=document.querySelectorAll('.filter-section')[0].querySelector('.fs-min');s.value='5';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
await new Promise(r=>setTimeout(r,1500));
console.log('artist min>=5 summary:', await evl(`document.querySelectorAll('.filter-section')[0].querySelector('.fs-summary').textContent`), '| total:', await evl(`document.querySelector('.total').textContent`));
console.log('EXC:', logs.length?logs:'none');
ws.close();
