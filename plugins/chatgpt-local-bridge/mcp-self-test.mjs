#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const dir = await fs.mkdtemp(path.join(os.tmpdir(),'clb-mcp-test-'));
const server = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-server.mjs');
const child = spawn(process.execPath,[server],{env:{...process.env,CHATGPT_LOCAL_BRIDGE_DATA_DIR:dir},stdio:['pipe','pipe','pipe']});
const rl = readline.createInterface({input:child.stdout,crlfDelay:Infinity});
const pending = new Map();
rl.on('line', line => { try { const m=JSON.parse(line); if(m.id!=null&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);} } catch {} });
function req(id,method,params={}) { return new Promise((resolve,reject)=>{ pending.set(id,resolve); child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n'); setTimeout(()=>{if(pending.delete(id))reject(new Error('timeout '+method));},5000);}); }
let errors=[];
try {
  const init=await req(1,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'selftest',version:'1'}});
  if(init.result?.serverInfo?.name!=='chatgpt-local-bridge') errors.push('initialize');
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const list=await req(2,'tools/list',{});
  const names=(list.result?.tools??[]).map(x=>x.name);
  for(const n of ['pc_status','screen_capture','mouse_move','paint_render_target','draw_in_paint','run_task']) if(!names.includes(n)) errors.push('missing '+n);
  const status=await req(3,'tools/call',{name:'pc_status',arguments:{}});
  if(status.result?.isError) errors.push('pc_status error');
} catch(e) { errors.push(String(e?.message??e)); }
child.stdin.end();
setTimeout(()=>child.kill(),300);
await fs.rm(dir,{recursive:true,force:true});
console.log(JSON.stringify({ok:errors.length===0,errors},null,2));
process.exitCode=errors.length?1:0;
