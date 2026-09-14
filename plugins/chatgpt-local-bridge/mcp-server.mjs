#!/usr/bin/env node
import readline from 'node:readline';
import path from 'node:path';
import { executeCommand, loadOrCreateConfig, localAppData, appendAudit, VERSION } from './bridge.mjs';

const SERVER_NAME = 'chatgpt-local-bridge';
const SUPPORTED_PROTOCOLS = ['2025-11-25','2025-06-18','2025-03-26','2024-11-05'];

const tool = (name, description, properties = {}, required = [], annotations = {}) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, additionalProperties: false, ...(required.length ? { required } : {}) },
  annotations
});
const str = (description, extra={}) => ({ type:'string', description, ...extra });
const num = (description, extra={}) => ({ type:'number', description, ...extra });
const int = (description, extra={}) => ({ type:'integer', description, ...extra });
const bool = (description) => ({ type:'boolean', description });

const TOOLS = [
  tool('pc_status','Return local PC/bridge status and visible windows.',{},[],{readOnlyHint:true}),
  tool('list_workspaces','List configured local workspace roots.',{},[],{readOnlyHint:true}),
  tool('list_windows','List visible Windows processes/windows.',{},[],{readOnlyHint:true}),
  tool('list_apps','Discover installed GUI applications. Optional query filters names.',{ query:str('Optional name filter') },[],{readOnlyHint:true}),
  tool('launch_app','Launch a discovered normal GUI application by name. Shell/interpreter executables remain blocked.',{ name:str('Installed app name or unique partial name') },['name']),
  tool('screen_info','Return virtual desktop geometry.',{},[],{readOnlyHint:true}),
  tool('screen_capture','Capture the desktop. The result includes an image content item.',{ maxWidth:int('Maximum returned image width',{minimum:640,maximum:1600}) },[],{readOnlyHint:true}),
  tool('screen_capture_region','Capture a desktop region.',{ x:int('Left screen coordinate'), y:int('Top screen coordinate'), width:int('Width',{minimum:1,maximum:4096}), height:int('Height',{minimum:1,maximum:4096}), maxWidth:int('Maximum returned image width',{minimum:64,maximum:1600}) },['x','y','width','height'],{readOnlyHint:true}),
  tool('find_paint_canvas','Detect the likely Microsoft Paint canvas rectangle from the current screen.',{},[],{readOnlyHint:true}),
  tool('draw_in_paint','MANDATORY high-level action for requests such as "open Paint and draw X" on this PC. Generate a self-contained SVG for the requested subject and call this tool instead of merely generating an image in chat. It opens/focuses Microsoft Paint, rasterizes the SVG locally, renders it into Paint, captures the result, and verifies it when possible.',{ svg:str('Complete self-contained SVG document. No scripts, external URLs, or embedded active content.',{maxLength:260000}), width:int('Target width in pixels',{minimum:64,maximum:1600}), height:int('Target height in pixels',{minimum:64,maximum:1600}), mode:str('exact pastes the rendered image; mouse visibly draws line art with the blue overlay',{enum:['exact','mouse']}), minScore:num('Minimum visual match before one corrective re-paste',{minimum:0,maximum:1}) },['svg']),
  tool('sample_canvas_pixel','Sample a screen pixel color.',{ x:int('Screen X'), y:int('Screen Y') },['x','y'],{readOnlyHint:true}),
  tool('mouse_move','Move the mouse with the blue control overlay.',{ x:int('Screen X'), y:int('Screen Y'), durationMs:int('Movement duration in milliseconds',{minimum:0,maximum:5000}) },['x','y']),
  tool('mouse_click','Click at a screen coordinate with the blue control overlay.',{ x:int('Screen X'), y:int('Screen Y'), button:str('left, right, or middle',{enum:['left','right','middle']}), clicks:int('Click count',{minimum:1,maximum:3}) },['x','y']),
  tool('mouse_drag','Drag through an explicit sequence of screen points.',{ points:{type:'array',description:'Ordered drag points',minItems:2,maxItems:2000,items:{type:'object',properties:{x:int('X'),y:int('Y')},required:['x','y'],additionalProperties:false}}, button:str('Mouse button',{enum:['left','right']}), durationMs:int('Approximate total duration',{minimum:50,maximum:120000}) },['points']),
  tool('mouse_scroll','Scroll at a screen coordinate.',{ x:int('Screen X'), y:int('Screen Y'), delta:int('Wheel delta', {minimum:-7200,maximum:7200}) },['x','y','delta']),
  tool('type_text','Type literal text into the focused GUI control.',{ text:str('Text to type',{maxLength:4000}) },['text']),
  tool('key_press','Press a key, optionally with modifiers.',{ key:str('Key name',{maxLength:16}), ctrl:bool('Ctrl modifier'), shift:bool('Shift modifier'), alt:bool('Alt modifier') },['key']),
  tool('image_target_create','Create a local PNG/JPEG image target from base64 bytes for Paint rendering.',{ base64:str('PNG or JPEG bytes encoded as base64'), name:str('Optional friendly target name') },['base64']),
  tool('image_target_info','Read metadata for a previously created image target.',{ targetId:str('Target identifier') },['targetId'],{readOnlyHint:true}),
  tool('clipboard_set_target','Put a local image target on the Windows clipboard.',{ targetId:str('Target identifier'), width:int('Optional clipboard image width',{minimum:1,maximum:4096}), height:int('Optional clipboard image height',{minimum:1,maximum:4096}) },['targetId']),
  tool('paint_render_target','Paste an image target into the foreground Paint canvas.',{ targetId:str('Target identifier'), width:int('Optional rendered width',{minimum:1,maximum:4096}), height:int('Optional rendered height',{minimum:1,maximum:4096}) },['targetId']),
  tool('paint_correct_target','Compare a target against a screen region and re-paste it into Paint when below the requested match score.',{ targetId:str('Target identifier'), x:int('Region X'), y:int('Region Y'), width:int('Region width',{minimum:1,maximum:4096}), height:int('Region height',{minimum:1,maximum:4096}), minScore:num('Minimum accepted match score 0..1',{minimum:0,maximum:1}), renderWidth:int('Optional re-render width',{minimum:1,maximum:4096}), renderHeight:int('Optional re-render height',{minimum:1,maximum:4096}) },['targetId','x','y','width','height']),
  tool('mouse_render_target','Render a prepared target into Paint using visible mouse strokes.',{ targetId:str('Target identifier'), x:int('Destination X'), y:int('Destination Y'), width:int('Render width',{minimum:16,maximum:1600}), height:int('Render height',{minimum:16,maximum:1200}) },['targetId','x','y','width','height']),
  tool('compare_target_region','Compare a screen region against an image target and return error metrics.',{ targetId:str('Target identifier'), x:int('Region X'), y:int('Region Y'), width:int('Region width',{minimum:1,maximum:4096}), height:int('Region height',{minimum:1,maximum:4096}) },['targetId','x','y','width','height'],{readOnlyHint:true}),
  tool('list_dir','List a directory inside an allowed workspace.',{ workspace:str('Workspace name'), relativePath:str('Relative directory path') },['workspace'],{readOnlyHint:true}),
  tool('read_file','Read a UTF-8 text file inside an allowed workspace.',{ workspace:str('Workspace name'), relativePath:str('Relative file path') },['workspace','relativePath'],{readOnlyHint:true}),
  tool('search_text','Search text inside files in an allowed workspace.',{ workspace:str('Workspace name'), query:str('Text to search for'), relativePath:str('Optional relative start directory') },['workspace','query'],{readOnlyHint:true}),
  tool('write_file','Write a UTF-8 text file inside an allowed workspace.',{ workspace:str('Workspace name'), relativePath:str('Relative file path'), text:str('Complete file text'), expectedSha256:str('Optional optimistic-concurrency SHA256') },['workspace','relativePath','text']),
  tool('mkdir','Create a directory inside an allowed workspace.',{ workspace:str('Workspace name'), relativePath:str('Relative directory path') },['workspace','relativePath']),
  tool('git_status','Run git status in an allowed workspace.',{ workspace:str('Workspace name') },['workspace'],{readOnlyHint:true}),
  tool('git_diff','Run git diff in an allowed workspace.',{ workspace:str('Workspace name') },['workspace'],{readOnlyHint:true}),
  tool('git_log','Read recent git log entries.',{ workspace:str('Workspace name'), count:int('Number of entries',{minimum:1,maximum:50}) },['workspace'],{readOnlyHint:true}),
  tool('run_task','Run one predefined project task: typecheck, test, build, or check.',{ workspace:str('Workspace name'), task:str('Task',{enum:['typecheck','test','build','check']}), packageDir:str('Optional package directory relative to workspace') },['workspace','task']),
  tool('npm_script','Run an npm script that already exists in package.json. No arbitrary shell string is accepted.',{ workspace:str('Workspace name'), script:str('Existing package.json script name'), packageDir:str('Optional package directory relative to workspace'), timeoutMs:int('Timeout ms',{minimum:10000,maximum:1200000}) },['workspace','script'])
];

const NAME_TO_ACTION = Object.fromEntries(TOOLS.map(t => [t.name, t.name.replaceAll('_','-')]));

function jsonRpcResult(id, result) { return { jsonrpc:'2.0', id, result }; }
function jsonRpcError(id, code, message, data) { return { jsonrpc:'2.0', id, error:{ code, message, ...(data===undefined?{}:{data}) } }; }
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

function sanitizeForText(value) {
  if (Array.isArray(value)) return value.map(sanitizeForText);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k,v] of Object.entries(value)) {
    if (k === 'base64' && typeof v === 'string') out[k] = `<omitted ${v.length} base64 chars>`;
    else out[k] = sanitizeForText(v);
  }
  return out;
}

function toolResponse(result) {
  const safe = sanitizeForText(result);
  const content = [{ type:'text', text: JSON.stringify(safe) }];
  const b64 = result?.data?.base64;
  if (typeof b64 === 'string' && b64.length > 16) {
    content.push({ type:'image', data:b64, mimeType: result?.data?.mime ?? 'image/png' });
  }
  return {
    content,
    structuredContent: safe,
    isError: result?.status === 'error'
  };
}

async function makeState() {
  const dataDir = localAppData();
  const { config, cfgPath } = await loadOrCreateConfig(dataDir);
  return {
    config, cfgPath, dataDir,
    appCache:null, appCacheAt:0,
    auditPath:path.join(dataDir,'audit-mcp.jsonl'),
    uiHelper:null,
    lastCommand:null
  };
}

const state = await makeState();

async function handleOne(msg) {
  if (!msg || typeof msg !== 'object') return;
  const id = msg.id;
  const method = msg.method;
  if (!method) return;

  if (method === 'initialize') {
    const requested = String(msg.params?.protocolVersion ?? '');
    const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
    if (id !== undefined) send(jsonRpcResult(id, {
      protocolVersion,
      capabilities:{ tools:{ listChanged:false } },
      serverInfo:{ name:SERVER_NAME, version:VERSION },
      instructions:'When the user asks to act on their own Windows PC, perform the action through these local tools instead of only describing it in chat. For any request to draw/create something in Microsoft Paint, use draw_in_paint and generate a self-contained SVG as its input; do not satisfy that PC request with chat image generation alone. Use structured tools only, prefer inspection before precise UI manipulation, and verify visible results after actions.'
    }));
    return;
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') { if (id !== undefined) send(jsonRpcResult(id, {})); return; }
  if (method === 'tools/list') { if (id !== undefined) send(jsonRpcResult(id, { tools: TOOLS })); return; }
  if (method === 'resources/list') { if (id !== undefined) send(jsonRpcResult(id, { resources: [{ uri:'bridge://about', name:'ChatGPT Local Bridge status', description:'Static information confirming the bridge MCP server is reachable.', mimeType:'text/plain' }] })); return; }
  if (method === 'resources/read') {
    const uri=String(msg.params?.uri??'');
    if (uri!=='bridge://about') { if(id!==undefined) send(jsonRpcError(id,-32602,`Unknown resource: ${uri}`)); return; }
    if(id!==undefined) send(jsonRpcResult(id,{contents:[{uri:'bridge://about',mimeType:'text/plain',text:`ChatGPT Local Bridge ${VERSION} reachable on this Windows PC.`}]})); return;
  }
  if (method === 'prompts/list') { if (id !== undefined) send(jsonRpcResult(id, { prompts: [] })); return; }
  if (method === 'tools/call') {
    const name = String(msg.params?.name ?? '');
    const args = msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {};
    const action = NAME_TO_ACTION[name];
    if (!action) { if (id !== undefined) send(jsonRpcError(id,-32602,`Unknown tool: ${name}`)); return; }
    const cmd = { ...args, action };
    const startedAt = new Date().toISOString();
    let result;
    try { result = await executeCommand(state, cmd); }
    catch (e) { result = { status:'error', message:String(e?.message ?? e) }; }
    state.lastCommand = { action, startedAt, completedAt:new Date().toISOString(), ...result };
    await appendAudit(state,{ source:'mcp', action, workspace:args.workspace ?? '', status:result.status, message:result.message });
    if (id !== undefined) send(jsonRpcResult(id, toolResponse(result)));
    return;
  }
  if (id !== undefined) send(jsonRpcError(id,-32601,`Method not found: ${method}`));
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); }
  catch { send(jsonRpcError(null,-32700,'Parse error')); return; }
  try {
    if (Array.isArray(msg)) {
      // Older clients may batch. Process sequentially so UI operations stay ordered.
      for (const item of msg) await handleOne(item);
    } else await handleOne(msg);
  } catch (e) {
    if (msg?.id !== undefined) send(jsonRpcError(msg.id,-32603,'Internal error',String(e?.message ?? e)));
  }
});

rl.on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
