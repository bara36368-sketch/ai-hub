const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = 8765;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DATA = path.join(__dirname, 'data');
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });

let cfg = fs.existsSync(path.join(DATA,'providers.json')) ? JSON.parse(fs.readFileSync(path.join(DATA,'providers.json'),'utf8')) : {providers:[]};
let keys = fs.existsSync(path.join(DATA,'keys.json')) ? JSON.parse(fs.readFileSync(path.join(DATA,'keys.json'),'utf8')) : {};

function provs(){return cfg.providers.map(p=>({...p,key:keys[p.id]||p.key})).sort((a,b)=>a.priority-b.priority)}

let cache={data:null,ts:0};
async function checkOne(p){
  const t=Date.now();
  try{
    const u=new URL(p.models_url||p.url.replace('/chat/completions','/models'));
    const h={};if(p.key)h['Authorization']=`Bearer ${p.key}`;
    const r=await fetch(u,{headers:h,signal:AbortSignal.timeout(800)});
    const ms=Date.now()-t;
    if(r.ok){const d=await r.json();return{...p,status:'online',latency:ms,models:(d.data||[]).map(m=>m.id||m.name).slice(0,20)}}
    return{...p,status:'error',latency:ms};
  }catch{return{...p,status:'offline',latency:Date.now()-t}}
}
async function refreshAll(){
  const ps=provs();const rs=await Promise.allSettled(ps.map(checkOne));
  cache={data:rs.map(c=>c.value||c.reason),ts:Date.now()};
}
refreshAll().catch(()=>{});

// Providers
app.get('/api/providers',(req,res)=>{
  if(cache.data)return res.json(cache.data);
  res.json([]);
});
app.get('/api/providers/:id/check',async(req,res)=>{
  const p=provs().find(x=>x.id===req.params.id);
  if(!p)return res.status(404).json({error:'Not found'});
  res.json(await checkOne(p));
});

// Keys
app.post('/api/keys',(req,res)=>{keys[req.body.providerId]=req.body.key;fs.writeFileSync(path.join(DATA,'keys.json'),JSON.stringify(keys,null,2));res.json({ok:1})});
app.get('/api/keys',(req,res)=>{const r={};for(const[k,v]of Object.entries(keys))r[k]=v?v.substring(0,8)+'...':'':res.json(r)});

// Custom provider
app.post('/api/providers/custom',(req,res)=>{
  const{id,name,url,key}=req.body;if(!id||!url)return res.status(400).json({error:'Need id+url'});
  cfg.providers.push({id,name:name||id,type:'openai',url,models_url:url.replace('/chat/completions','/models'),key:key||'',enabled:true,free:true,priority:99});
  if(key)keys[id]=key;
  fs.writeFileSync(path.join(DATA,'providers.json'),JSON.stringify(cfg,null,2));
  fs.writeFileSync(path.join(DATA,'keys.json'),JSON.stringify(keys,null,2));
  res.json({ok:1});
});
app.post('/api/providers/:id/toggle',(req,res)=>{const p=cfg.providers.find(x=>x.id===req.params.id);if(p){p.enabled=!p.enabled;fs.writeFileSync(path.join(DATA,'providers.json'),JSON.stringify(cfg,null,2))}res.json({ok:1})});

// Chat router
app.post('/v1/chat/completions',async(req,res)=>{
  const ps=provs().filter(p=>p.enabled);
  for(const p of ps){
    try{const h={'Content-Type':'application/json'};if(p.key)h['Authorization']=`Bearer ${p.key}`;
    const b={...req.body};if(b.model==='auto')delete b.model;
    const r=await fetch(p.url,{method:'POST',headers:h,body:JSON.stringify(b),signal:AbortSignal.timeout(30000)});
    if(r.ok){const d=await r.json();if(d.choices?.length){res.setHeader('X-Provider',p.id);return res.json(d)}}
    }catch{}
  }
  res.status(502).json({error:'All providers failed'});
});

// Files
app.get('/api/files',(req,res)=>{
  const dir=req.query.dir||__dirname;
  try{const items=fs.readdirSync(dir,{withFileTypes:true});
  res.json({dir,files:items.filter(i=>!i.name.startsWith('.')).map(i=>{const fp=path.join(dir,i.name);let s;try{s=fs.statSync(fp)}catch{}return{name:i.name,isDirectory:i.isDirectory(),size:s?.size||0,path:fp}}).sort((a,b)=>b.isDirectory-a.isDirectory||a.name.localeCompare(b.name))})}
  catch(e){res.status(500).json({error:e.message})}
});
app.get('/api/files/read',(req,res)=>{try{res.json({path:req.query.path,content:fs.readFileSync(req.query.path,'utf8')})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/files/write',(req,res)=>{try{fs.writeFileSync(req.body.path,req.body.content,'utf8');res.json({ok:1})}catch(e){res.status(500).json({error:e.message})}});

// AI edit
app.post('/api/ai/chat',async(req,res)=>{
  const{messages,provider}=req.body;if(!messages?.length)return res.status(400).json({error:'Need messages'});
  const sys={role:'system',content:'You are an AI coding assistant. Read/write/create/edit files. Return code with syntax. Be concise.'};
  const ps=provs().filter(p=>p.enabled);const ordered=provider?ps.filter(p=>p.id===provider):ps;
  for(const p of ordered){
    try{const h={'Content-Type':'application/json'};if(p.key)h['Authorization']=`Bearer ${p.key}`;
    const r=await fetch(p.url,{method:'POST',headers:h,body:JSON.stringify({model:'auto',messages:[sys,...messages],max_tokens:4096}),signal:AbortSignal.timeout(60000)});
    if(r.ok){const d=await r.json();if(d.choices?.[0]?.message?.content)return res.json({content:d.choices[0].message.content,provider:p.id})}}catch{}
  }
  res.status(502).json({error:'All providers failed'});
});

// Network
app.get('/api/network',(req,res)=>{
  const os=require('os');const nets=os.networkInterfaces();const ips=[];
  for(const n of Object.keys(nets))for(const net of nets[n])if(net.family==='IPv4'&&!net.internal)ips.push({name:n,address:net.address});
  res.json({ips,hostname:os.hostname(),port:PORT});
});

app.listen(PORT,'0.0.0.0',()=>{
  const os=require('os');const nets=os.networkInterfaces();let ip='localhost';
  for(const n of Object.keys(nets))for(const net of nets[n])if(net.family==='IPv4'&&!net.internal){ip=net.address;break}
  console.log(`\n  AI Hub running!`);
  console.log(`  Phone: http://${ip}:${PORT}`);
  console.log(`  Local: http://localhost:${PORT}\n`);
});
