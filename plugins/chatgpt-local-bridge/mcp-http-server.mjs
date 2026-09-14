#!/usr/bin/env node
import http from 'node:http';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const PORT=Number(process.env.CHATGPT_LOCAL_BRIDGE_HTTP_PORT||43123);
const HOST='127.0.0.1';
const TOKEN=String(process.env.CHATGPT_LOCAL_BRIDGE_HTTP_TOKEN||'');
if(TOKEN.length<32){console.error('CHATGPT_LOCAL_BRIDGE_HTTP_TOKEN missing/too short');process.exit(2)}
const SESSION=crypto.randomBytes(18).toString('base64url');
const child=spawn(process.execPath,[path.join(root,'mcp-server.mjs')],{cwd:root,env:process.env,stdio:['pipe','pipe','inherit'],windowsHide:true});
const rl=readline.createInterface({input:child.stdout,crlfDelay:Infinity});
const pending=new Map();
rl.on('line',line=>{let m;try{m=JSON.parse(line)}catch{return};if(m?.id!==undefined&&pending.has(String(m.id))){const q=pending.get(String(m.id));pending.delete(String(m.id));q.resolve(m)}});
child.on('exit',(code)=>{for(const q of pending.values())q.reject(new Error(`MCP child exited ${code}`));pending.clear();process.exit(code??1)});
function auth(req){const h=String(req.headers.authorization||'');const want=`Bearer ${TOKEN}`;try{return h.length===want.length&&crypto.timingSafeEqual(Buffer.from(h),Buffer.from(want))}catch{return false}}
function json(res,code,obj){const b=Buffer.from(JSON.stringify(obj));res.writeHead(code,{'content-type':'application/json','content-length':b.length,'cache-control':'no-store','mcp-session-id':SESSION});res.end(b)}
function call(msg,timeout=120000){return new Promise((resolve,reject)=>{if(msg.id===undefined){child.stdin.write(JSON.stringify(msg)+'\n');resolve(null);return}const k=String(msg.id);const t=setTimeout(()=>{pending.delete(k);reject(new Error('MCP timeout'))},timeout);pending.set(k,{resolve:(v)=>{clearTimeout(t);resolve(v)},reject:(e)=>{clearTimeout(t);reject(e)}});child.stdin.write(JSON.stringify(msg)+'\n')})}
const server=http.createServer(async(req,res)=>{
  if(req.url==='/healthz'||req.url==='/readyz'){json(res,200,{ok:true,version:'16.4.0',mcpChild:!child.killed});return}
  if(req.url!=='/mcp'){json(res,404,{error:'not_found'});return}
  if(!auth(req)){res.writeHead(401,{'www-authenticate':'Bearer','cache-control':'no-store'});res.end('unauthorized');return}
  if(req.method==='OPTIONS'){res.writeHead(204,{'allow':'POST, GET, OPTIONS','access-control-allow-origin':'*','access-control-allow-headers':'authorization,content-type,mcp-session-id'});res.end();return}
  if(req.method==='GET'){
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive','mcp-session-id':SESSION});
    res.write(': ChatGPT Local Bridge stream\n\n');
    const tm=setInterval(()=>{try{res.write(': ping\n\n')}catch{}},15000);req.on('close',()=>clearInterval(tm));return
  }
  if(req.method!=='POST'){res.writeHead(405,{allow:'POST, GET, OPTIONS'});res.end();return}
  let chunks=[],n=0;for await(const c of req){n+=c.length;if(n>1024*1024){res.writeHead(413);res.end();return}chunks.push(c)}
  let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{json(res,400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});return}
  try{
    if(Array.isArray(body)){const out=[];for(const m of body){const r=await call(m);if(r)out.push(r)};if(out.length)json(res,200,out);else res.writeHead(202,{'mcp-session-id':SESSION}).end();return}
    const r=await call(body);if(r)json(res,200,r);else res.writeHead(202,{'mcp-session-id':SESSION}).end()
  }catch(e){json(res,502,{jsonrpc:'2.0',id:body?.id??null,error:{code:-32603,message:'Bridge backend error',data:String(e?.message??e)}})}
});
server.listen(PORT,HOST,()=>console.log(JSON.stringify({ok:true,type:'mcp-http',url:`http://${HOST}:${PORT}/mcp`,health:`http://${HOST}:${PORT}/readyz`,pid:process.pid})));
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{try{child.kill()}catch{};server.close(()=>process.exit(0))});
