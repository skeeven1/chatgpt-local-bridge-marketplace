#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const VERSION = '16.4.0';
const PROTOCOL = 'chatgpt-local-bridge-v15';
const IS_WIN = process.platform === 'win32';
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const POLL_MS = 3000;
const HEARTBEAT_MS = 60000;
const COMMAND_MAX_LIFETIME_MS = 5 * 60 * 1000;
const COMMAND_CLOCK_SKEW_MS = 90 * 1000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.turbo', 'coverage']);
const BLOCKED_EXECUTABLES = new Set([
  'cmd','cmd.exe','powershell','powershell.exe','pwsh','pwsh.exe','wscript','wscript.exe','cscript','cscript.exe','mshta','mshta.exe',
  'rundll32','rundll32.exe','regsvr32','regsvr32.exe','wmic','wmic.exe','reg','reg.exe','sc','sc.exe','schtasks','schtasks.exe',
  'certutil','certutil.exe','bitsadmin','bitsadmin.exe'
]);
const BLOCKED_TARGET_EXTENSIONS = new Set(['.bat','.cmd','.ps1','.psm1','.vbs','.vbe','.js','.jse','.wsf','.wsh','.reg','.msc']);
const SAFE_URL_SCHEMES = new Set(['steam:','uplay:','ubisoftconnect:','com.epicgames.launcher:']);
const MAX_SVG_CHARS = 260000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();
const truncate = (s, n = MAX_OUTPUT_BYTES) => {
  const b = Buffer.from(String(s ?? ''), 'utf8');
  if (b.length <= n) return b.toString('utf8');
  return b.subarray(b.length - n).toString('utf8') + '\n...[truncated]';
};
const sha256Text = (s) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

function localAppData() {
  if (process.env.CHATGPT_LOCAL_BRIDGE_DATA_DIR) return process.env.CHATGPT_LOCAL_BRIDGE_DATA_DIR;
  if (process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'ChatGPTLocalBridgeV16');
  return path.join(os.homedir(), '.chatgpt-local-bridge-v16');
}

function ghExecutable(config) {
  if (process.env.CHATGPT_LOCAL_BRIDGE_GH) return process.env.CHATGPT_LOCAL_BRIDGE_GH;
  if (config?.ghPath) return config.ghPath;
  if (IS_WIN) {
    const p = 'C:\\Program Files\\GitHub CLI\\gh.exe';
    if (fs.existsSync(p)) return p;
  }
  return 'gh';
}

function npmExecutable() {
  if (IS_WIN) {
    const p = 'C:\\Program Files\\nodejs\\npm.cmd';
    if (fs.existsSync(p)) return p;
    return 'npm.cmd';
  }
  return 'npm';
}

function gitExecutable() { return IS_WIN ? 'git.exe' : 'git'; }

async function runCaptured(file, args = [], opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const input = opts.input ?? null;
  return await new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const append = (cur, chunk) => {
      const next = Buffer.concat([cur, Buffer.from(chunk)]);
      return next.length > MAX_OUTPUT_BYTES ? next.subarray(next.length - MAX_OUTPUT_BYTES) : next;
    };
    child.stdout.on('data', (d) => { stdout = append(stdout, d); });
    child.stderr.on('data', (d) => { stderr = append(stderr, d); });
    const finish = (obj) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        code: obj.code ?? null,
        signal: obj.signal ?? null,
        timedOut: !!obj.timedOut,
        error: obj.error ? String(obj.error.message ?? obj.error) : '',
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8')
      });
    };
    child.on('error', (error) => finish({ code: null, error }));
    child.on('close', (code, signal) => finish({ code, signal }));
    if (input != null) child.stdin.end(input); else child.stdin.end();
    timer = setTimeout(async () => {
      try {
        if (IS_WIN && child.pid) {
          spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' }).unref();
        } else {
          child.kill('SIGKILL');
        }
      } catch {}
      finish({ code: null, timedOut: true });
    }, timeoutMs);
  });
}

function runDetached(file, args = [], opts = {}) {
  const child = spawn(file, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    shell: false,
    detached: true,
    windowsHide: false,
    stdio: 'ignore'
  });
  child.unref();
  return child.pid ?? null;
}

function sameOrChild(root, candidate) {
  const r = path.resolve(root);
  const c = path.resolve(candidate);
  const rr = IS_WIN ? r.toLowerCase() : r;
  const cc = IS_WIN ? c.toLowerCase() : c;
  return cc === rr || cc.startsWith(rr.endsWith(path.sep) ? rr : rr + path.sep);
}

async function realOrNearestParent(p) {
  let cur = p;
  for (;;) {
    try { return { existing: cur, real: await fsp.realpath(cur) }; }
    catch (e) {
      const parent = path.dirname(cur);
      if (parent === cur) throw e;
      cur = parent;
    }
  }
}

async function resolveInside(root, relativePath, { allowRoot = false } = {}) {
  if (typeof relativePath !== 'string') throw new Error('relativePath must be a string');
  if (relativePath.includes('\0')) throw new Error('NUL path rejected');
  if (path.isAbsolute(relativePath)) throw new Error('Absolute paths are not allowed');
  const rootReal = await fsp.realpath(root);
  const candidate = path.resolve(rootReal, relativePath || '.');
  if (!sameOrChild(rootReal, candidate)) throw new Error('Path escapes workspace');
  if (!allowRoot && path.resolve(candidate) === path.resolve(rootReal)) throw new Error('Workspace root is not a file target');
  const nearest = await realOrNearestParent(candidate);
  if (!sameOrChild(rootReal, nearest.real)) throw new Error('Symlink escape rejected');
  try {
    const targetReal = await fsp.realpath(candidate);
    if (!sameOrChild(rootReal, targetReal)) throw new Error('Symlink escape rejected');
  } catch (e) {
    if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') throw e;
  }
  return candidate;
}

function cleanRoots(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (/^[a-zA-Z0-9._-]{1,64}$/.test(k) && typeof v === 'string' && v.trim()) out[k] = path.resolve(v);
  }
  return out;
}

async function loadOrCreateConfig(dataDir) {
  await fsp.mkdir(dataDir, { recursive: true });
  const cfgPath = path.join(dataDir, 'config.json');
  let config = null;
  try { config = JSON.parse(await fsp.readFile(cfgPath, 'utf8')); } catch {}

  if (!config) {
    const oldCfgCandidates = [
      path.join(process.env.LOCALAPPDATA ?? '', 'ChatGPTLocalBridgeV15', 'config.json'),
      path.join(process.env.LOCALAPPDATA ?? '', 'ChatGPTLocalBridgeV14_3', 'config.json')
    ];
    let old = null;
    for (const oldCfg of oldCfgCandidates) {
      try { old = JSON.parse(await fsp.readFile(oldCfg, 'utf8')); if (old) break; } catch {}
    }
    const roots = cleanRoots(old?.allowedRoots ?? old?.workspaces ?? old?.roots);
    if (!Object.keys(roots).length) roots.doonce = path.join(os.homedir(), 'Desktop', 'doonce');
    config = {
      relayRepo: ((old?.relayRepo && String(old.relayRepo).startsWith('skeeven1/')) ? old.relayRepo : ((old?.commandRepo && String(old.commandRepo).startsWith('skeeven1/')) ? old.commandRepo : 'skeeven1/chatgpt-local-bridge-marketplace')),
      relayBranch: old?.relayBranch ?? old?.commandBranch ?? 'main',
      relayPath: '.chatgpt-local-bridge/command.json',
      telemetryRepo: old?.telemetryRepo ?? 'skeeven1/doonce-control-telemetry-public',
      telemetryBranch: old?.telemetryBranch ?? 'main',
      sessionPath: '.chatgpt-local-bridge/session-v15.json',
      statusPath: '.chatgpt-local-bridge/status-v15.enc',
      allowedRoots: roots,
      pollMs: POLL_MS,
      heartbeatMs: HEARTBEAT_MS
    };
    await fsp.writeFile(cfgPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  }
  let migrated = false;
  if (!String(config.relayRepo ?? '').startsWith('skeeven1/')) {
    config.relayRepo = 'skeeven1/chatgpt-local-bridge-marketplace';
    config.relayBranch = 'main';
    config.relayPath = '.chatgpt-local-bridge/command.json';
    migrated = true;
  }
  config.allowedRoots = cleanRoots(config.allowedRoots);
  if (!Object.keys(config.allowedRoots).length) { config.allowedRoots.doonce = path.join(os.homedir(), 'Desktop', 'doonce'); migrated = true; }
  if (migrated) await fsp.writeFile(cfgPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return { config, cfgPath };
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

async function acquireSingleInstance(dataDir) {
  const lockPath = path.join(dataDir, 'bridge.lock');
  const token = crypto.randomBytes(12).toString('hex');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = await fsp.open(lockPath, 'wx', 0o600);
      await fd.writeFile(JSON.stringify({ pid: process.pid, token, startedAt: nowIso() }) + '\n', 'utf8');
      await fd.close();
      const release = () => {
        try {
          const cur = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          if (cur?.token === token) fs.unlinkSync(lockPath);
        } catch {}
      };
      process.once('exit', release);
      return { lockPath, release };
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      let cur = null;
      try { cur = JSON.parse(await fsp.readFile(lockPath, 'utf8')); } catch {}
      if (processExists(Number(cur?.pid))) throw new Error(`ChatGPT Local Bridge is already running (PID ${cur.pid})`);
      try { await fsp.unlink(lockPath); } catch {}
    }
  }
  throw new Error('Unable to acquire single-instance lock');
}

async function loadOrCreateMasterKey(dataDir) {
  const dst = path.join(dataDir, 'bridge.key');
  const candidates = [
    dst,
    path.join(process.env.LOCALAPPDATA ?? '', 'ChatGPTLocalBridgeV15', 'bridge.key'),
    path.join(process.env.LOCALAPPDATA ?? '', 'ChatGPTLocalBridgeV14_3', 'bridge.key'),
    path.join(process.env.LOCALAPPDATA ?? '', 'DoOnceCodexLikeV14', 'bridge.key')
  ];
  for (const p of candidates) {
    if (!p) continue;
    try {
      const text = (await fsp.readFile(p, 'utf8')).trim();
      const b = Buffer.from(text, 'base64');
      if (b.length === 32) {
        if (p !== dst) await fsp.writeFile(dst, text + '\n', { encoding: 'utf8', mode: 0o600 });
        return { key: b, keyPath: dst, importedFrom: p === dst ? null : p };
      }
    } catch {}
  }
  const b = crypto.randomBytes(32);
  await fsp.writeFile(dst, b.toString('base64') + '\n', { encoding: 'utf8', mode: 0o600 });
  return { key: b, keyPath: dst, importedFrom: null };
}

function deriveTelemetryKeys(masterKey) {
  const salt = Buffer.from('ChatGPT Local Bridge V15 HKDF salt', 'utf8');
  const encKey = Buffer.from(crypto.hkdfSync('sha256', masterKey, salt, Buffer.from('telemetry-aes-256-gcm-v1'), 32));
  const macKey = Buffer.from(crypto.hkdfSync('sha256', masterKey, salt, Buffer.from('telemetry-hmac-sha256-v1'), 32));
  return { encKey, macKey };
}

function encryptTelemetry(obj, masterKey) {
  const { encKey, macKey } = deriveTelemetryKeys(masterKey);
  const nonce = crypto.randomBytes(12);
  const aad = Buffer.from(PROTOCOL, 'utf8');
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, nonce);
  cipher.setAAD(aad);
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const gcmTag = cipher.getAuthTag();
  const payload = Buffer.concat([nonce, gcmTag, ciphertext]);
  const mac = crypto.createHmac('sha256', macKey).update(Buffer.from('v15.', 'utf8')).update(payload).digest();
  return `v15.${payload.toString('base64')}.${mac.toString('base64')}`;
}

function decryptTelemetryForSelfTest(text, masterKey) {
  const m = /^v15\.([A-Za-z0-9+/=]+)\.([A-Za-z0-9+/=]+)$/.exec(text);
  if (!m) throw new Error('Bad envelope');
  const payload = Buffer.from(m[1], 'base64');
  const mac = Buffer.from(m[2], 'base64');
  const { encKey, macKey } = deriveTelemetryKeys(masterKey);
  const expected = crypto.createHmac('sha256', macKey).update(Buffer.from('v15.', 'utf8')).update(payload).digest();
  if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) throw new Error('Bad HMAC');
  const nonce = payload.subarray(0, 12);
  const gcmTag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, nonce);
  decipher.setAAD(Buffer.from(PROTOCOL, 'utf8'));
  decipher.setAuthTag(gcmTag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
}

function encodeRepoPath(p) { return p.split('/').map(encodeURIComponent).join('/'); }

async function ghApi(gh, args, { input = null, timeoutMs = 30000 } = {}) {
  const r = await runCaptured(gh, ['api', ...args], { input, timeoutMs });
  if (r.code !== 0) {
    const e = new Error(`gh api failed (${r.code ?? 'no-code'}): ${truncate(r.stderr || r.stdout, 4000)}`);
    e.result = r;
    throw e;
  }
  return r.stdout;
}

async function githubGetFile(gh, repo, filePath, branch) {
  const ep = `repos/${repo}/contents/${encodeRepoPath(filePath)}?ref=${encodeURIComponent(branch)}`;
  try {
    const out = await ghApi(gh, ['--method', 'GET', ep]);
    const j = JSON.parse(out);
    return { exists: true, sha: j.sha, text: Buffer.from(String(j.content ?? '').replace(/\s/g, ''), 'base64').toString('utf8') };
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/404|Not Found/i.test(msg)) return { exists: false, sha: null, text: '' };
    throw e;
  }
}

async function githubPutFile(gh, repo, filePath, branch, text, message) {
  const ep = `repos/${repo}/contents/${encodeRepoPath(filePath)}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await githubGetFile(gh, repo, filePath, branch);
    const body = { message, content: Buffer.from(text, 'utf8').toString('base64'), branch };
    if (current.sha) body.sha = current.sha;
    try {
      const out = await ghApi(gh, ['--method', 'PUT', ep, '--input', '-'], { input: JSON.stringify(body), timeoutMs: 45000 });
      return JSON.parse(out);
    } catch (e) {
      if (attempt < 3 && /409|422|does not match|sha/i.test(String(e?.message ?? e))) { await sleep(500 * (attempt + 1)); continue; }
      throw e;
    }
  }
  throw new Error('Unable to update GitHub file after retries');
}

function publicSession(state) {
  return {
    protocol: PROTOCOL,
    agentVersion: VERSION,
    online: state.online,
    sessionId: state.sessionId,
    startedAt: state.startedAt,
    heartbeatAt: state.heartbeatAt,
    workspaces: Object.keys(state.config.allowedRoots),
    capabilities: [
      'pc-status','list-workspaces','list-dir','search-text','read-file','write-file','copy-file','move-file','mkdir','delete-file',
      'list-processes','list-windows','list-apps','launch-app','stop-process','screen-info','screen-capture','screen-capture-region','sample-canvas-pixel','find-paint-canvas',
      'mouse-move','mouse-click','mouse-drag','mouse-scroll','type-text','key-press','image-target-create','image-target-info','image-target-delete',
      'clipboard-set-target','paint-render-target','paint-correct-target','mouse-render-target','compare-target-region','run-task','npm-script','git-status','git-diff','git-log','git-commit'
    ],
    commandTransport: 'github-authenticated-json',
    telemetryTransport: 'aes-256-gcm+hmac-sha256'
  };
}

function privateStatus(state) {
  return {
    ...publicSession(state),
    userName: os.userInfo().username,
    hostName: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    pid: process.pid,
    lastCommand: state.lastCommand ?? null
  };
}

async function publish(state, { forceStatus = false, reason = 'heartbeat' } = {}) {
  state.heartbeatAt = nowIso();
  const pub = JSON.stringify(publicSession(state), null, 2) + '\n';
  await githubPutFile(state.gh, state.config.telemetryRepo, state.config.sessionPath, state.config.telemetryBranch, pub, `chatgpt local bridge session v15 (${reason})`);
  if (forceStatus) {
    const enc = encryptTelemetry(privateStatus(state), state.masterKey) + '\n';
    await githubPutFile(state.gh, state.config.telemetryRepo, state.config.statusPath, state.config.telemetryBranch, enc, `chatgpt local bridge telemetry v15 (${reason})`);
  }
  state.lastPublishedAt = Date.now();
}

function validateCommand(cmd, state) {
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) throw new Error('Command must be an object');
  if (cmd.protocol !== PROTOCOL) throw new Error('Protocol mismatch');
  if (typeof cmd.id !== 'string' || !/^[A-Za-z0-9._:-]{1,120}$/.test(cmd.id)) throw new Error('Invalid command id');
  if (cmd.sessionId !== state.sessionId) throw new Error('Session mismatch');
  if (typeof cmd.action !== 'string' || !cmd.action) throw new Error('Missing action');
  const issued = Date.parse(cmd.issuedAt);
  const expires = Date.parse(cmd.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) throw new Error('Bad command timestamps');
  const now = Date.now();
  if (issued > now + COMMAND_CLOCK_SKEW_MS) throw new Error('Command issued in the future');
  if (expires <= now) throw new Error('Command expired');
  if (expires - issued <= 0 || expires - issued > COMMAND_MAX_LIFETIME_MS) throw new Error('Command lifetime rejected');
  return true;
}

function workspaceRoot(state, cmd) {
  const name = String(cmd.workspace ?? cmd.root ?? '');
  if (!name || !state.config.allowedRoots[name]) throw new Error(`Unknown workspace: ${name || '(missing)'}`);
  return { name, root: state.config.allowedRoots[name] };
}

async function readSmallText(file) {
  const st = await fsp.stat(file);
  if (!st.isFile()) throw new Error('Not a file');
  if (st.size > MAX_TEXT_BYTES) throw new Error(`File too large (${st.size} bytes)`);
  return await fsp.readFile(file, 'utf8');
}

async function listDirAction(state, cmd) {
  const { root } = workspaceRoot(state, cmd);
  const p = await resolveInside(root, String(cmd.relativePath ?? '.'), { allowRoot: true });
  const entries = await fsp.readdir(p, { withFileTypes: true });
  const data = [];
  for (const e of entries.slice(0, 1000)) {
    let size = null;
    try { if (e.isFile()) size = (await fsp.stat(path.join(p, e.name))).size; } catch {}
    data.push({ name: e.name, type: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : e.isSymbolicLink() ? 'symlink' : 'other', size });
  }
  return { status: 'ok', message: `${data.length} entries`, data };
}

async function walkFiles(root, maxFiles = 5000) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (out.length >= maxFiles) break;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(p);
      } else if (e.isFile()) out.push(p);
    }
  }
  return out;
}

async function searchTextAction(state, cmd) {
  const { root } = workspaceRoot(state, cmd);
  const query = String(cmd.query ?? '');
  if (!query || query.length > 500) throw new Error('Invalid search query');
  const base = await resolveInside(root, String(cmd.relativePath ?? '.'), { allowRoot: true });
  const files = await walkFiles(base, 5000);
  const q = cmd.caseSensitive ? query : query.toLowerCase();
  const results = [];
  for (const file of files) {
    if (results.length >= 200) break;
    let st; try { st = await fsp.stat(file); } catch { continue; }
    if (st.size > 2 * 1024 * 1024) continue;
    let text; try { text = await fsp.readFile(file, 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && results.length < 200; i++) {
      const hay = cmd.caseSensitive ? lines[i] : lines[i].toLowerCase();
      if (hay.includes(q)) results.push({ path: path.relative(root, file), line: i + 1, text: truncate(lines[i], 1200) });
    }
  }
  return { status: 'ok', message: `${results.length} matches`, data: results };
}

async function readFileAction(state, cmd) {
  const { root } = workspaceRoot(state, cmd);
  const rel = String(cmd.relativePath ?? cmd.path ?? '');
  const p = await resolveInside(root, rel);
  const text = await readSmallText(p);
  return { status: 'ok', message: `Read ${rel}`, data: { relativePath: rel, text, sha256: sha256Text(text), bytes: Buffer.byteLength(text) } };
}

async function writeFileAction(state, cmd) {
  const { root } = workspaceRoot(state, cmd);
  const rel = String(cmd.relativePath ?? cmd.path ?? '');
  const text = String(cmd.text ?? cmd.content ?? '');
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new Error('Text too large');
  const p = await resolveInside(root, rel);
  if (cmd.expectedSha256) {
    let cur = ''; try { cur = await fsp.readFile(p, 'utf8'); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
    if (sha256Text(cur) !== String(cmd.expectedSha256)) throw new Error('expectedSha256 mismatch');
  }
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, text, 'utf8');
  return { status: 'ok', message: `Wrote ${rel}`, data: { relativePath: rel, sha256: sha256Text(text), bytes: Buffer.byteLength(text) } };
}

async function mkdirAction(state, cmd) {
  const { root } = workspaceRoot(state, cmd);
  const rel = String(cmd.relativePath ?? cmd.path ?? '');
  const p = await resolveInside(root, rel);
  await fsp.mkdir(p, { recursive: true });
  return { status: 'ok', message: `Created directory ${rel}` };
}

async function copyMoveAction(state, cmd, move) {
  const { root } = workspaceRoot(state, cmd);
  const srcRel = String(cmd.source ?? cmd.from ?? '');
  const dstRel = String(cmd.destination ?? cmd.to ?? '');
  const src = await resolveInside(root, srcRel);
  const dst = await resolveInside(root, dstRel);
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  if (move) await fsp.rename(src, dst); else await fsp.copyFile(src, dst, fs.constants.COPYFILE_EXCL);
  return { status: 'ok', message: `${move ? 'Moved' : 'Copied'} ${srcRel} -> ${dstRel}` };
}


function helperScriptPath() {
  const script = path.resolve(process.argv[1] ?? 'bridge.mjs');
  return path.join(path.dirname(script), 'ui-helper.ps1');
}

function rejectUiPending(state, message) {
  const h = state.uiHelper;
  if (!h) return;
  for (const { reject, timer } of h.pending.values()) {
    clearTimeout(timer);
    reject(new Error(message));
  }
  h.pending.clear();
}

async function startUiHelper(state) {
  if (!IS_WIN) throw new Error('UI control is only available on Windows');
  if (state.uiHelper?.alive) return;
  const helper = helperScriptPath();
  if (!fs.existsSync(helper)) throw new Error(`UI helper missing: ${helper}`);
  const child = spawn('powershell.exe', ['-Sta','-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File', helper], {
    shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe']
  });
  const h = { child, pending: new Map(), nextId: 1, alive: true, stderr: '' };
  state.uiHelper = h;
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  h.readline = rl;
  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const pending = h.pending.get(String(msg.id ?? ''));
    if (!pending) return;
    h.pending.delete(String(msg.id));
    clearTimeout(pending.timer);
    if (msg.ok) pending.resolve(msg.data ?? {});
    else pending.reject(new Error(String(msg.error ?? 'UI helper error')));
  });
  child.stderr.on('data', (d) => { h.stderr = truncate(h.stderr + Buffer.from(d).toString('utf8'), 16000); });
  child.on('error', (e) => {
    h.alive = false;
    rejectUiPending(state, `UI helper process error: ${e.message}`);
  });
  child.on('exit', (code, signal) => {
    h.alive = false;
    rejectUiPending(state, `UI helper exited (${code ?? signal ?? 'unknown'}): ${h.stderr}`);
  });
  await callUiHelperExisting(state, 'ping', {}, 15000);
}

async function callUiHelperExisting(state, action, payload = {}, timeoutMs = 15000) {
  const h = state.uiHelper;
  if (!h?.alive) throw new Error('UI helper is not running');
  const id = `ui-${process.pid}-${h.nextId++}`;
  const req = { id, action, ...payload };
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      h.pending.delete(id);
      reject(new Error(`UI helper timeout: ${action}`));
    }, timeoutMs);
    h.pending.set(id, { resolve, reject, timer });
    try { h.child.stdin.write(JSON.stringify(req) + '\n', 'utf8'); }
    catch (e) { clearTimeout(timer); h.pending.delete(id); reject(e); }
  });
}

async function callUiHelper(state, action, payload = {}, timeoutMs = 15000) {
  if (!state.uiHelper?.alive) await startUiHelper(state);
  return await callUiHelperExisting(state, action, payload, timeoutMs);
}

function intField(value, name, min = -100000, max = 100000) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}`);
  return n;
}

async function screenInfoAction(state) {
  const data = await callUiHelper(state, 'screen-info');
  return { status: 'ok', message: 'Screen geometry collected', data };
}

async function screenCaptureAction(state, cmd) {
  const maxWidth = Math.min(1600, Math.max(640, Number(cmd.maxWidth ?? 1280)));
  const data = await callUiHelper(state, 'screen-capture', { maxWidth }, 30000);
  if (typeof data.base64 !== 'string' || data.base64.length > 760000) throw new Error('Screenshot payload rejected');
  return { status: 'ok', message: `Screen captured ${data.imageWidth}x${data.imageHeight}`, data };
}



function validateSafeSvg(svg) {
  const text = String(svg ?? '').trim();
  if (!text || text.length > MAX_SVG_CHARS) throw new Error('SVG payload missing or too large');
  if (!/^<svg[\s>]/i.test(text)) throw new Error('draw_in_paint requires a self-contained <svg> document');
  const blocked = [
    /<script\b/i, /<foreignObject\b/i, /<iframe\b/i, /<object\b/i, /<embed\b/i,
    /\bon[a-z]+\s*=/i, /javascript\s*:/i, /@import\b/i,
    /url\s*\(\s*["']?\s*(?:https?|file|data):/i,
    /(?:xlink:)?href\s*=\s*["']\s*(?!#)/i
  ];
  for (const re of blocked) if (re.test(text)) throw new Error('SVG contains blocked active or external content');
  return text;
}

function edgeExecutable() {
  const candidates = [];
  if (process.env.PROGRAMFILES_X86) candidates.push(path.join(process.env.PROGRAMFILES_X86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  if (process.env.PROGRAMFILES) candidates.push(path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return IS_WIN ? 'msedge.exe' : '';
}

async function rasterizeSvgToPng(state, svg, width, height) {
  if (!IS_WIN) throw new Error('SVG rasterization for Paint is available on Windows only');
  const safeSvg = validateSafeSvg(svg);
  const w = intField(width ?? 900, 'width', 64, 1600);
  const h = intField(height ?? 900, 'height', 64, 1600);
  const dir = path.join(state.dataDir, 'renders');
  await fsp.mkdir(dir, { recursive: true });
  const nonce = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const htmlPath = path.join(dir, `render-${nonce}.html`);
  const pngPath = path.join(dir, `render-${nonce}.png`);
  const profileDir = path.join(dir, `edge-profile-${nonce}`);
  const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#fff}svg{width:100vw!important;height:100vh!important;display:block}</style>${safeSvg}`;
  await fsp.writeFile(htmlPath, html, 'utf8');
  await fsp.mkdir(profileDir, { recursive: true });
  const edge = edgeExecutable();
  const url = pathToFileURL(htmlPath).href;
  const common = ['--no-first-run','--disable-features=msEdgeFirstRunExperience','--disable-gpu','--hide-scrollbars',`--user-data-dir=${profileDir}`,`--window-size=${w},${h}`,`--screenshot=${pngPath}`,url];
  let r = await runCaptured(edge, ['--headless=new', ...common], { timeoutMs: 45000 });
  if (r.code !== 0 || !fs.existsSync(pngPath)) {
    r = await runCaptured(edge, ['--headless', ...common], { timeoutMs: 45000 });
  }
  await fsp.rm(htmlPath, { force: true });
  await fsp.rm(profileDir, { recursive: true, force: true });
  if (r.code !== 0 || !fs.existsSync(pngPath)) throw new Error(`Microsoft Edge SVG rasterization failed: ${truncate(r.stderr || r.stdout || r.error, 2000)}`);
  const buf = await fsp.readFile(pngPath);
  await fsp.rm(pngPath, { force: true });
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) throw new Error('Rasterized image rejected');
  return { buf, width: w, height: h };
}

async function focusWindowHandle(state, hwnd) {
  const h = Number(hwnd);
  if (!Number.isFinite(h) || h <= 0) throw new Error('Invalid window handle');
  const data = await callUiHelper(state, 'focus-window', { hwnd: h }, 12000);
  return data;
}

function isPaintWindow(p) {
  const proc = String(p?.ProcessName ?? '').toLowerCase();
  const title = String(p?.MainWindowTitle ?? '').toLowerCase();
  return proc === 'mspaint' || title === 'paint' || title.endsWith(' - paint') || title.includes('microsoft paint');
}

async function ensurePaintForeground(state) {
  let win = (await processList()).find((p) => Number(p.MainWindowHandle) !== 0 && isPaintWindow(p));
  if (!win) {
    try { await launchAppAction(state, { name: 'Paint' }); }
    catch { runDetached('mspaint.exe', []); }
    for (let i = 0; i < 20; i++) {
      await sleep(350);
      win = (await processList()).find((p) => Number(p.MainWindowHandle) !== 0 && isPaintWindow(p));
      if (win) break;
    }
  }
  if (!win) throw new Error('Microsoft Paint did not expose a visible window');
  await focusWindowHandle(state, Number(win.MainWindowHandle));
  await sleep(350);
  return { pid: Number(win.Id), hwnd: Number(win.MainWindowHandle), title: String(win.MainWindowTitle ?? 'Paint') };
}

async function drawInPaintAction(state, cmd) {
  const mode = String(cmd.mode ?? 'exact').toLowerCase();
  if (!['exact','mouse'].includes(mode)) throw new Error('mode must be exact or mouse');
  const width = intField(cmd.width ?? 900, 'width', 64, 1600);
  const height = intField(cmd.height ?? 900, 'height', 64, 1600);
  const raster = await rasterizeSvgToPng(state, cmd.svg, width, height);
  const target = await imageTargetCreateAction(state, { base64: raster.buf.toString('base64') });
  const targetId = target.data.targetId;
  const paint = await ensurePaintForeground(state);
  let canvas;
  try { canvas = (await findPaintCanvasAction(state)).data; }
  catch { canvas = null; }

  let renderWidth = width, renderHeight = height;
  if (canvas) {
    const scale = Math.min(1, Number(canvas.width) / width, Number(canvas.height) / height);
    renderWidth = Math.max(32, Math.floor(width * scale));
    renderHeight = Math.max(32, Math.floor(height * scale));
  }

  let render;
  if (mode === 'mouse') {
    if (!canvas) throw new Error('Paint canvas detection is required for visible mouse rendering');
    render = await mouseRenderTargetAction(state, {
      targetId, x: Number(canvas.x), y: Number(canvas.y), width: renderWidth, height: renderHeight,
      threshold: cmd.threshold ?? 170, sampleStep: cmd.sampleStep ?? 2, maxRuns: cmd.maxRuns ?? 9000
    });
  } else {
    render = await paintRenderTargetAction(state, { targetId, width: renderWidth, height: renderHeight });
  }

  await sleep(800);
  let comparison = null;
  if (canvas) {
    try {
      comparison = (await compareTargetRegionAction(state, {
        targetId, x: Number(canvas.x), y: Number(canvas.y), width: renderWidth, height: renderHeight
      })).data;
      if (mode === 'exact' && Number(comparison.matchScore ?? 0) < Number(cmd.minScore ?? 0.94)) {
        await ensurePaintForeground(state);
        await paintRenderTargetAction(state, { targetId, width: renderWidth, height: renderHeight });
        await sleep(600);
        comparison = (await compareTargetRegionAction(state, {
          targetId, x: Number(canvas.x), y: Number(canvas.y), width: renderWidth, height: renderHeight
        })).data;
      }
    } catch {}
  }

  let screenshot = null;
  try { screenshot = (await screenCaptureAction(state, { maxWidth: 1280 })).data; } catch {}
  const score = comparison == null ? null : Number(comparison.matchScore ?? 0);
  return {
    status: 'ok',
    message: score == null ? `Rendered drawing in Paint (${mode})` : `Rendered drawing in Paint (${mode}), visual match ${(score*100).toFixed(1)}%`,
    data: {
      targetId, mode, paint, canvas, renderWidth, renderHeight, comparison,
      ...(screenshot ? { base64: screenshot.base64, mime: screenshot.mime, imageWidth: screenshot.imageWidth, imageHeight: screenshot.imageHeight } : {})
    }
  };
}

function decodeImagePayload(base64) {
  if (typeof base64 !== 'string' || base64.length < 16 || base64.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 16) throw new Error('Invalid image payload length');
  let buf;
  try { buf = Buffer.from(base64, 'base64'); } catch { throw new Error('Invalid image base64'); }
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) throw new Error('Image payload too large');
  const png = buf.length >= 8 && buf.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  const jpg = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (!png && !jpg) throw new Error('Only PNG and JPEG images are accepted');
  return { buf, mime: png ? 'image/png' : 'image/jpeg', ext: png ? '.png' : '.jpg' };
}

function targetIdField(value) {
  const id = String(value ?? '');
  if (!/^[a-f0-9]{20,64}$/i.test(id)) throw new Error('Invalid targetId');
  return id.toLowerCase();
}

async function targetDir(state) {
  const d = path.join(state.dataDir, 'targets');
  await fsp.mkdir(d, { recursive: true });
  return d;
}

async function targetFileById(state, id) {
  const tid = targetIdField(id);
  const d = await targetDir(state);
  for (const ext of ['.png','.jpg']) {
    const f = path.join(d, tid + ext);
    try { const st = await fsp.stat(f); if (st.isFile()) return { file: f, tid, ext, size: st.size }; } catch {}
  }
  throw new Error('Unknown image target');
}

async function imageTargetCreateAction(state, cmd) {
  const { buf, mime, ext } = decodeImagePayload(cmd.base64 ?? cmd.imageBase64);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const tid = hash.slice(0, 24);
  const d = await targetDir(state);
  const file = path.join(d, tid + ext);
  await fsp.writeFile(file, buf, { mode: 0o600 });
  return { status: 'ok', message: `Image target stored: ${tid}`, data: { targetId: tid, mime, bytes: buf.length, sha256: hash } };
}

async function imageTargetInfoAction(state, cmd) {
  const t = await targetFileById(state, cmd.targetId);
  const buf = await fsp.readFile(t.file);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  return { status: 'ok', message: `Image target ${t.tid}`, data: { targetId: t.tid, bytes: t.size, sha256: hash, mime: t.ext === '.png' ? 'image/png' : 'image/jpeg' } };
}

async function imageTargetDeleteAction(state, cmd) {
  const t = await targetFileById(state, cmd.targetId);
  await fsp.unlink(t.file);
  return { status: 'ok', message: `Image target deleted: ${t.tid}`, data: { targetId: t.tid } };
}

async function imageTargetBase64(state, id) {
  const t = await targetFileById(state, id);
  if (t.size > MAX_IMAGE_BYTES) throw new Error('Stored image target too large');
  const buf = await fsp.readFile(t.file);
  return { ...t, base64: buf.toString('base64'), mime: t.ext === '.png' ? 'image/png' : 'image/jpeg' };
}

function regionFields(cmd) {
  return {
    x: intField(cmd.x, 'x'), y: intField(cmd.y, 'y'),
    width: intField(cmd.width, 'width', 1, 10000), height: intField(cmd.height, 'height', 1, 10000)
  };
}

async function screenCaptureRegionAction(state, cmd) {
  const region = regionFields(cmd);
  const maxWidth = Math.min(1600, Math.max(160, Number(cmd.maxWidth ?? Math.min(1280, region.width))));
  const data = await callUiHelper(state, 'screen-capture-region', { ...region, maxWidth }, 30000);
  if (typeof data.base64 !== 'string' || data.base64.length > 760000) throw new Error('Screenshot payload rejected');
  return { status: 'ok', message: `Screen region captured ${data.imageWidth}x${data.imageHeight}`, data };
}

async function findPaintCanvasAction(state) {
  const data = await callUiHelper(state, 'find-bright-region', {}, 30000);
  if (!data || !Number.isFinite(Number(data.width)) || Number(data.width) < 64 || Number(data.height) < 64) throw new Error('No plausible Paint canvas found');
  return { status: 'ok', message: `Paint canvas candidate ${data.width}x${data.height}`, data };
}


async function sampleCanvasPixelAction(state, cmd) {
  const x = intField(cmd.x, 'x'); const y = intField(cmd.y, 'y');
  const data = await callUiHelper(state, 'sample-pixel', { x, y }, 12000);
  return { status: 'ok', message: `Pixel ${x},${y} = ${data.hex}`, data };
}

async function clipboardSetTargetAction(state, cmd) {
  const t = await imageTargetBase64(state, cmd.targetId);
  const width = cmd.width == null ? 0 : intField(cmd.width, 'width', 1, 4096);
  const height = cmd.height == null ? 0 : intField(cmd.height, 'height', 1, 4096);
  const data = await callUiHelper(state, 'clipboard-set-image', { base64: t.base64, width, height }, 45000);
  return { status: 'ok', message: `Target ${t.tid} copied to image clipboard`, data: { targetId: t.tid, ...data } };
}

async function paintRenderTargetAction(state, cmd) {
  const t = await imageTargetBase64(state, cmd.targetId);
  const width = cmd.width == null ? 0 : intField(cmd.width, 'width', 1, 4096);
  const height = cmd.height == null ? 0 : intField(cmd.height, 'height', 1, 4096);
  const data = await callUiHelper(state, 'paint-render-image', { base64: t.base64, width, height }, 60000);
  return { status: 'ok', message: `Target ${t.tid} pasted into foreground app`, data: { targetId: t.tid, ...data } };
}


async function paintCorrectTargetAction(state, cmd) {
  const t = await imageTargetBase64(state, cmd.targetId);
  const region = regionFields(cmd);
  const minScore = Math.max(0, Math.min(1, Number(cmd.minScore ?? 0.985)));
  const before = await callUiHelper(state, 'compare-image-region', { base64: t.base64, ...region }, 60000);
  if (Number(before.matchScore ?? 0) >= minScore) {
    return { status: 'ok', message: `Canvas already matches target ${(Number(before.matchScore)*100).toFixed(1)}%`, data: { targetId: t.tid, corrected: false, before } };
  }
  const width = cmd.renderWidth == null ? region.width : intField(cmd.renderWidth, 'renderWidth', 1, 4096);
  const height = cmd.renderHeight == null ? region.height : intField(cmd.renderHeight, 'renderHeight', 1, 4096);
  const paste = await callUiHelper(state, 'paint-render-image', { base64: t.base64, width, height }, 60000);
  await sleep(700);
  let after = null;
  try { after = await callUiHelper(state, 'compare-image-region', { base64: t.base64, ...region }, 60000); } catch {}
  return { status: 'ok', message: `Canvas correction applied`, data: { targetId: t.tid, corrected: true, before, after, paste } };
}

async function mouseRenderTargetAction(state, cmd) {
  const t = await imageTargetBase64(state, cmd.targetId);
  const region = regionFields(cmd);
  const threshold = intField(cmd.threshold ?? 128, 'threshold', 0, 255);
  const sampleStep = intField(cmd.sampleStep ?? 3, 'sampleStep', 1, 16);
  const maxRuns = intField(cmd.maxRuns ?? 5000, 'maxRuns', 1, 12000);
  const data = await callUiHelper(state, 'mouse-render-line-art', { base64: t.base64, ...region, threshold, sampleStep, maxRuns }, 180000);
  return { status: 'ok', message: `Mouse line-art render complete (${data.runs} runs)`, data: { targetId: t.tid, ...data } };
}

async function compareTargetRegionAction(state, cmd) {
  const t = await imageTargetBase64(state, cmd.targetId);
  const region = regionFields(cmd);
  const data = await callUiHelper(state, 'compare-image-region', { base64: t.base64, ...region }, 60000);
  return { status: 'ok', message: `Target comparison score ${(Number(data.matchScore ?? 0) * 100).toFixed(1)}%`, data: { targetId: t.tid, ...data } };
}

async function mouseMoveAction(state, cmd) {
  const x = intField(cmd.x, 'x'); const y = intField(cmd.y, 'y');
  const durationMs = Math.min(5000, Math.max(0, Number(cmd.durationMs ?? 350)));
  const data = await callUiHelper(state, 'mouse-move', { x, y, durationMs }, 12000);
  return { status: 'ok', message: `Mouse moved to ${data.x},${data.y}`, data };
}

async function mouseClickAction(state, cmd) {
  const x = intField(cmd.x, 'x'); const y = intField(cmd.y, 'y');
  const button = String(cmd.button ?? 'left').toLowerCase();
  if (!['left','right','middle'].includes(button)) throw new Error('Unsupported mouse button');
  const clicks = Math.min(3, Math.max(1, intField(cmd.clicks ?? 1, 'clicks', 1, 3)));
  const data = await callUiHelper(state, 'mouse-click', { x, y, button, clicks }, 12000);
  return { status: 'ok', message: `${button} click at ${x},${y}`, data };
}

async function mouseDragAction(state, cmd) {
  if (!Array.isArray(cmd.points) || cmd.points.length < 2 || cmd.points.length > 2000) throw new Error('mouse-drag requires 2..2000 points');
  const points = cmd.points.map((p) => ({ x: intField(p?.x, 'point.x'), y: intField(p?.y, 'point.y') }));
  const button = String(cmd.button ?? 'left').toLowerCase();
  if (!['left','right','middle'].includes(button)) throw new Error('Unsupported mouse button');
  const durationMs = Math.min(30000, Math.max(50, Number(cmd.durationMs ?? Math.max(120, points.length * 12))));
  const data = await callUiHelper(state, 'mouse-drag', { points, button, durationMs }, durationMs + 10000);
  return { status: 'ok', message: `Mouse drag complete (${points.length} points)`, data };
}

async function mouseScrollAction(state, cmd) {
  const x = intField(cmd.x, 'x'); const y = intField(cmd.y, 'y');
  const delta = intField(cmd.delta, 'delta', -7200, 7200);
  const data = await callUiHelper(state, 'mouse-scroll', { x, y, delta }, 12000);
  return { status: 'ok', message: `Mouse scrolled ${delta} at ${x},${y}`, data };
}

async function typeTextAction(state, cmd) {
  const text = String(cmd.text ?? '');
  if (!text || text.length > 4000) throw new Error('Invalid text length');
  const data = await callUiHelper(state, 'type-text', { text }, 20000);
  return { status: 'ok', message: `Typed ${data.chars} characters`, data };
}

async function keyPressAction(state, cmd) {
  const key = String(cmd.key ?? '').trim();
  if (!key || key.length > 16) throw new Error('Invalid key');
  const data = await callUiHelper(state, 'key-press', { key, ctrl: !!cmd.ctrl, shift: !!cmd.shift, alt: !!cmd.alt }, 12000);
  return { status: 'ok', message: `Key pressed: ${[cmd.ctrl?'Ctrl':'',cmd.shift?'Shift':'',cmd.alt?'Alt':'',key].filter(Boolean).join('+')}`, data };
}

async function confirmWindows(title, text) {
  if (!IS_WIN) return false;
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    '$r=[System.Windows.Forms.MessageBox]::Show($env:CLB_CONFIRM_TEXT,$env:CLB_CONFIRM_TITLE,[System.Windows.Forms.MessageBoxButtons]::YesNo,[System.Windows.Forms.MessageBoxIcon]::Warning);',
    'if($r -eq [System.Windows.Forms.DialogResult]::Yes){Write-Output YES}else{Write-Output NO}'
  ].join(' ');
  const env = { ...process.env, CLB_CONFIRM_TITLE: title, CLB_CONFIRM_TEXT: text };
  const r = await runCaptured('powershell.exe', ['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-Command', ps], { env, timeoutMs: 120000 });
  return r.code === 0 && /YES/.test(r.stdout);
}

async function deleteFileAction(state, cmd) {
  const { root } = workspaceRoot(state, cmd);
  const rel = String(cmd.relativePath ?? cmd.path ?? '');
  const p = await resolveInside(root, rel);
  if (!await confirmWindows('ChatGPT Local Bridge', `Autoriser la suppression de :\n${p}`)) throw new Error('User declined deletion');
  const st = await fsp.lstat(p);
  if (st.isDirectory()) throw new Error('delete-file only accepts files');
  await fsp.unlink(p);
  return { status: 'ok', message: `Deleted ${rel}` };
}

async function gitAction(state, cmd, kind) {
  const { root } = workspaceRoot(state, cmd);
  let args;
  if (kind === 'status') args = ['-C', root, 'status', '--short', '--branch', '--untracked-files=normal'];
  else if (kind === 'diff') args = ['-C', root, 'diff', '--no-ext-diff', '--'];
  else if (kind === 'log') args = ['-C', root, 'log', '--oneline', '--decorate', '-n', String(Math.min(50, Math.max(1, Number(cmd.count ?? 20))))];
  else throw new Error('Unknown git action');
  const r = await runCaptured(gitExecutable(), args, { cwd: root, timeoutMs: 30000 });
  if (r.timedOut) return { status: 'error', message: `git-${kind} timed out`, outputTail: truncate(r.stderr || r.stdout) };
  if (r.code !== 0) return { status: 'error', message: `git-${kind} failed (${r.code ?? 'no-code'})`, outputTail: truncate(r.stderr || r.stdout) };
  return { status: 'ok', message: `git-${kind} complete`, outputTail: truncate(r.stdout) };
}

async function gitCommitAction(state, cmd) {
  const { root } = workspaceRoot(state, cmd);
  const message = String(cmd.message ?? '').trim();
  if (!message || message.length > 500) throw new Error('Invalid commit message');
  if (!await confirmWindows('ChatGPT Local Bridge', `Autoriser un commit Git dans :\n${root}\n\nMessage :\n${message}`)) throw new Error('User declined git commit');
  if (cmd.stageAll !== false) {
    const add = await runCaptured(gitExecutable(), ['-C', root, 'add', '-A'], { timeoutMs: 30000 });
    if (add.code !== 0) return { status: 'error', message: 'git add failed', outputTail: truncate(add.stderr || add.stdout) };
  }
  const r = await runCaptured(gitExecutable(), ['-C', root, 'commit', '-m', message], { timeoutMs: 60000 });
  return r.code === 0
    ? { status: 'ok', message: 'Git commit created', outputTail: truncate(r.stdout) }
    : { status: 'error', message: `git commit failed (${r.code ?? 'no-code'})`, outputTail: truncate(r.stderr || r.stdout) };
}

async function npmScriptAction(state, cmd) {
  const { root } = workspaceRoot(state, cmd);
  const packageDirRel = String(cmd.packageDir ?? '.');
  const packageDir = await resolveInside(root, packageDirRel, { allowRoot: true });
  const pkgPath = path.join(packageDir, 'package.json');
  const pkg = JSON.parse(await readSmallText(pkgPath));
  const script = String(cmd.script ?? '');
  if (!script || !pkg.scripts || typeof pkg.scripts[script] !== 'string') throw new Error(`npm script not found: ${script}`);
  const r = await runCaptured(npmExecutable(), ['run', script], { cwd: packageDir, timeoutMs: Math.min(20 * 60 * 1000, Math.max(10000, Number(cmd.timeoutMs ?? 10 * 60 * 1000))) });
  return r.code === 0
    ? { status: 'ok', message: `npm run ${script} succeeded`, outputTail: truncate((r.stdout + '\n' + r.stderr).trim()) }
    : { status: 'error', message: `npm run ${script} failed (${r.code ?? 'no-code'}${r.timedOut ? ', timeout' : ''})`, outputTail: truncate((r.stdout + '\n' + r.stderr).trim()) };
}

async function runTaskAction(state, cmd) {
  const task = String(cmd.task ?? cmd.name ?? '');
  if (!['typecheck','test','build','check'].includes(task)) throw new Error('Unsupported task');
  return await npmScriptAction(state, { ...cmd, script: task, packageDir: cmd.packageDir ?? '.' });
}

async function processList() {
  if (!IS_WIN) return [];
  const ps = "Get-Process | Select-Object Id,ProcessName,MainWindowHandle,MainWindowTitle | ConvertTo-Json -Compress";
  const r = await runCaptured('powershell.exe', ['-NoLogo','-NoProfile','-Command', ps], { timeoutMs: 20000 });
  if (r.code !== 0) throw new Error(truncate(r.stderr || r.stdout, 4000));
  if (!r.stdout.trim()) return [];
  const v = JSON.parse(r.stdout.trim());
  return Array.isArray(v) ? v : [v];
}

async function listProcessesAction() {
  const items = await processList();
  return { status: 'ok', message: `${items.length} processes`, data: items.slice(0, 1000) };
}

async function listWindowsAction() {
  const items = (await processList()).filter((p) => Number(p.MainWindowHandle) !== 0 || String(p.MainWindowTitle ?? '').trim());
  return { status: 'ok', message: `${items.length} visible windows`, data: items };
}

function allowedLaunchTarget(target) {
  if (!target || typeof target !== 'string') return false;
  const t = target.trim();
  if (!t || t.startsWith('\\\\')) return false;
  const ext = path.extname(t).toLowerCase();
  if (BLOCKED_TARGET_EXTENSIONS.has(ext)) return false;
  const base = path.basename(t).toLowerCase();
  if (BLOCKED_EXECUTABLES.has(base)) return false;
  if (!['.exe','.com'].includes(ext)) return false;
  if (IS_WIN && !path.win32.isAbsolute(t)) return false;
  try { if (IS_WIN && !fs.statSync(t).isFile()) return false; } catch { if (IS_WIN) return false; }
  return true;
}


async function discoverAppsWindows() {
  if (!IS_WIN) return [];
  const ps = `
$ErrorActionPreference='SilentlyContinue'
$items=@()
Get-StartApps | ForEach-Object { if($_.Name -and $_.AppID){ $items += [pscustomobject]@{name=[string]$_.Name;kind='uwp';appId=[string]$_.AppID;shortcutPath='';target='';url=''} } }
$shell=New-Object -ComObject WScript.Shell
$roots=@("$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs","$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs","$env:USERPROFILE\\Desktop")
foreach($root in $roots){
  if(Test-Path -LiteralPath $root){
    Get-ChildItem -LiteralPath $root -Recurse -File -Filter *.lnk | ForEach-Object {
      $s=$shell.CreateShortcut($_.FullName)
      $items += [pscustomobject]@{name=[IO.Path]::GetFileNameWithoutExtension($_.Name);kind='shortcut';appId='';shortcutPath=[string]$_.FullName;target=[string]$s.TargetPath;url=''}
    }
    Get-ChildItem -LiteralPath $root -Recurse -File -Filter *.url | ForEach-Object {
      $u=''; Get-Content -LiteralPath $_.FullName | ForEach-Object { if($_ -match '^URL=(.+)$'){ $u=$Matches[1] } }
      if($u){ $items += [pscustomobject]@{name=[IO.Path]::GetFileNameWithoutExtension($_.Name);kind='url';appId='';shortcutPath=[string]$_.FullName;target='';url=[string]$u} }
    }
  }
}
$keys=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\*')
foreach($k in $keys){ Get-ItemProperty $k | ForEach-Object { if($_.'(default)'){ $items += [pscustomobject]@{name=[IO.Path]::GetFileNameWithoutExtension($_.PSChildName);kind='app-path';appId='';shortcutPath='';target=[string]$_.'(default)';url=''} } } }
$items | ConvertTo-Json -Compress -Depth 4
`;
  const r = await runCaptured('powershell.exe', ['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-Command', ps], { timeoutMs: 45000 });
  if (r.code !== 0) throw new Error(`App discovery failed: ${truncate(r.stderr || r.stdout, 4000)}`);
  let arr = [];
  if (r.stdout.trim()) {
    const v = JSON.parse(r.stdout.trim());
    arr = Array.isArray(v) ? v : [v];
  }
  const seen = new Set();
  const out = [];
  for (const a of arr) {
    const name = String(a.name ?? '').trim();
    if (!name) continue;
    if ((a.kind === 'shortcut' || a.kind === 'app-path') && !allowedLaunchTarget(String(a.target ?? ''))) continue;
    if (a.kind === 'url') {
      let scheme = ''; try { scheme = new URL(String(a.url)).protocol.toLowerCase(); } catch { continue; }
      if (!SAFE_URL_SCHEMES.has(scheme)) continue;
    }
    const key = `${name.toLowerCase()}|${a.kind}|${String(a.target ?? a.appId ?? a.url ?? '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, kind: a.kind, appId: a.appId || '', shortcutPath: a.shortcutPath || '', target: a.target || '', url: a.url || '' });
  }
  out.sort((a,b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return out;
}

function resolveAppByName(apps, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) throw new Error('Missing app name');
  const exact = apps.filter((a) => a.name.toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    // Windows often exposes the same GUI app twice (for example through
    // Get-StartApps and a Start Menu shortcut). For an exact same-name
    // duplicate, prefer the most concrete, locally validated launch route.
    const priority = { shortcut: 0, 'app-path': 1, uwp: 2, url: 3 };
    return [...exact].sort((a, b) => (priority[a.kind] ?? 99) - (priority[b.kind] ?? 99))[0];
  }
  const partial = apps.filter((a) => a.name.toLowerCase().includes(q));
  if (partial.length === 1) return partial[0];
  if (!partial.length) throw new Error(`App not found: ${query}`);
  const distinctNames = [...new Set(partial.map((a) => a.name.toLowerCase()))];
  if (distinctNames.length === 1) {
    const priority = { shortcut: 0, 'app-path': 1, uwp: 2, url: 3 };
    return [...partial].sort((a, b) => (priority[a.kind] ?? 99) - (priority[b.kind] ?? 99))[0];
  }
  throw new Error(`Ambiguous app name: ${query} (${partial.slice(0,10).map((a)=>a.name).join(', ')})`);
}

async function getApps(state, force = false) {
  if (!force && state.appCache && Date.now() - state.appCacheAt < 5 * 60 * 1000) return state.appCache;
  state.appCache = await discoverAppsWindows();
  state.appCacheAt = Date.now();
  return state.appCache;
}

async function listAppsAction(state) {
  const apps = await getApps(state, true);
  return { status: 'ok', message: `${apps.length} apps discovered`, data: apps.map((a) => ({ name: a.name, kind: a.kind, target: a.target ? path.basename(a.target) : '', appId: a.appId })) };
}

async function launchAppAction(state, cmd) {
  const apps = await getApps(state, false);
  const app = resolveAppByName(apps, cmd.name ?? cmd.app ?? '');
  let pid = null;
  if (app.kind === 'uwp') pid = runDetached('explorer.exe', [`shell:AppsFolder\\${app.appId}`]);
  else if (app.kind === 'shortcut') {
    if (!allowedLaunchTarget(app.target)) throw new Error('Blocked launch target');
    pid = runDetached('explorer.exe', [app.shortcutPath]);
  } else if (app.kind === 'app-path') {
    if (!allowedLaunchTarget(app.target)) throw new Error('Blocked launch target');
    pid = runDetached(app.target, [], { cwd: path.dirname(app.target) });
  } else if (app.kind === 'url') {
    const scheme = new URL(app.url).protocol.toLowerCase();
    if (!SAFE_URL_SCHEMES.has(scheme)) throw new Error('Blocked URL scheme');
    pid = runDetached('explorer.exe', [app.url]);
  } else throw new Error('Unsupported app kind');
  return { status: 'ok', message: `Launch requested: ${app.name}`, data: { name: app.name, kind: app.kind, pid } };
}

async function stopProcessAction(state, cmd) {
  const pid = Number(cmd.pid);
  if (!Number.isInteger(pid) || pid <= 4 || pid === process.pid) throw new Error('Invalid PID');
  if (!await confirmWindows('ChatGPT Local Bridge', `Autoriser l'arrêt du processus PID ${pid} ?`)) throw new Error('User declined process stop');
  if (IS_WIN) {
    const args = ['/PID', String(pid), '/T']; if (cmd.force) args.push('/F');
    const r = await runCaptured('taskkill.exe', args, { timeoutMs: 30000 });
    return r.code === 0 ? { status: 'ok', message: `Stopped PID ${pid}`, outputTail: truncate(r.stdout) } : { status: 'error', message: `taskkill failed (${r.code})`, outputTail: truncate(r.stderr || r.stdout) };
  }
  process.kill(pid, cmd.force ? 'SIGKILL' : 'SIGTERM');
  return { status: 'ok', message: `Stopped PID ${pid}` };
}

async function pcStatusAction(state) {
  let windows = [];
  if (IS_WIN) { try { windows = (await processList()).filter((p) => Number(p.MainWindowHandle) !== 0 || String(p.MainWindowTitle ?? '').trim()); } catch {} }
  return {
    status: 'ok', message: 'PC status collected', data: {
      hostName: os.hostname(), userName: os.userInfo().username, platform: process.platform, release: os.release(), arch: process.arch,
      node: process.version, uptimeSeconds: Math.round(os.uptime()), freeMemory: os.freemem(), totalMemory: os.totalmem(),
      bridgePid: process.pid, visibleWindows: windows.slice(0,200)
    }
  };
}

async function executeCommand(state, cmd) {
  switch (cmd.action) {
    case 'pc-status': case 'status': return await pcStatusAction(state);
    case 'list-workspaces': return { status: 'ok', message: 'Workspaces listed', data: state.config.allowedRoots };
    case 'list-dir': return await listDirAction(state, cmd);
    case 'search-text': return await searchTextAction(state, cmd);
    case 'read-file': return await readFileAction(state, cmd);
    case 'write-file': return await writeFileAction(state, cmd);
    case 'mkdir': return await mkdirAction(state, cmd);
    case 'copy-file': return await copyMoveAction(state, cmd, false);
    case 'move-file': return await copyMoveAction(state, cmd, true);
    case 'delete-file': return await deleteFileAction(state, cmd);
    case 'list-processes': return await listProcessesAction(state, cmd);
    case 'list-windows': return await listWindowsAction(state, cmd);
    case 'list-apps': return await listAppsAction(state, cmd);
    case 'launch-app': return await launchAppAction(state, cmd);
    case 'stop-process': return await stopProcessAction(state, cmd);
    case 'screen-info': return await screenInfoAction(state, cmd);
    case 'screen-capture': return await screenCaptureAction(state, cmd);
    case 'screen-capture-region': return await screenCaptureRegionAction(state, cmd);
    case 'sample-canvas-pixel': return await sampleCanvasPixelAction(state, cmd);
    case 'find-paint-canvas': return await findPaintCanvasAction(state, cmd);
    case 'draw-in-paint': return await drawInPaintAction(state, cmd);
    case 'image-target-create': return await imageTargetCreateAction(state, cmd);
    case 'image-target-info': return await imageTargetInfoAction(state, cmd);
    case 'image-target-delete': return await imageTargetDeleteAction(state, cmd);
    case 'clipboard-set-target': return await clipboardSetTargetAction(state, cmd);
    case 'paint-render-target': return await paintRenderTargetAction(state, cmd);
    case 'paint-correct-target': return await paintCorrectTargetAction(state, cmd);
    case 'mouse-render-target': return await mouseRenderTargetAction(state, cmd);
    case 'compare-target-region': return await compareTargetRegionAction(state, cmd);
    case 'mouse-move': return await mouseMoveAction(state, cmd);
    case 'mouse-click': return await mouseClickAction(state, cmd);
    case 'mouse-drag': return await mouseDragAction(state, cmd);
    case 'mouse-scroll': return await mouseScrollAction(state, cmd);
    case 'type-text': return await typeTextAction(state, cmd);
    case 'key-press': return await keyPressAction(state, cmd);
    case 'run-task': return await runTaskAction(state, cmd);
    case 'npm-script': return await npmScriptAction(state, cmd);
    case 'git-status': return await gitAction(state, cmd, 'status');
    case 'git-diff': return await gitAction(state, cmd, 'diff');
    case 'git-log': return await gitAction(state, cmd, 'log');
    case 'git-commit': return await gitCommitAction(state, cmd);
    default: throw new Error(`Unsupported action: ${cmd.action}`);
  }
}

async function appendAudit(state, entry) {
  try {
    const line = JSON.stringify({ at: nowIso(), ...entry }) + '\n';
    await fsp.appendFile(state.auditPath, line, { encoding: 'utf8', mode: 0o600 });
  } catch {}
}

async function handleCommand(state, cmd) {
  const startedAt = nowIso();
  let result;
  try { result = await executeCommand(state, cmd); }
  catch (e) { result = { status: 'error', message: String(e?.message ?? e), outputTail: truncate(e?.stack ?? '', 12000) }; }
  state.lastCommand = {
    id: cmd.id, action: cmd.action, workspace: cmd.workspace ?? cmd.root ?? '', startedAt, completedAt: nowIso(), ...result
  };
  console.log(`[${nowIso()}] ${cmd.id} ${cmd.action} -> ${result.status}: ${result.message}`);
  await appendAudit(state, { id: cmd.id, action: cmd.action, workspace: cmd.workspace ?? cmd.root ?? '', status: result.status, message: result.message });
  try { await publish(state, { forceStatus: true, reason: `command ${cmd.id}` }); }
  catch (e) { console.error(`[${nowIso()}] telemetry publish failed after command:`, e.message); }
}

async function pollOnce(state) {
  const file = await githubGetFile(state.gh, state.config.relayRepo, state.config.relayPath, state.config.relayBranch);
  if (!file.exists || !file.text.trim()) return;
  let cmd;
  try { cmd = JSON.parse(file.text); } catch { return; }
  if (cmd?.protocol !== PROTOCOL) return;
  if (state.processedIds.has(cmd.id)) return;
  try { validateCommand(cmd, state); }
  catch (e) {
    if (cmd?.sessionId === state.sessionId && cmd?.id && !state.processedIds.has(cmd.id)) {
      state.processedIds.add(cmd.id);
      state.lastCommand = { id: cmd.id, action: cmd.action ?? '', status: 'rejected', message: String(e.message), completedAt: nowIso() };
      await appendAudit(state, { id: cmd.id, action: cmd.action ?? '', workspace: cmd.workspace ?? cmd.root ?? '', status: 'rejected', message: String(e.message) });
      try { await publish(state, { forceStatus: true, reason: `rejected ${cmd.id}` }); } catch {}
    }
    return;
  }
  state.processedIds.add(cmd.id);
  while (state.processedIds.size > 500) state.processedIds.delete(state.processedIds.values().next().value);
  await handleCommand(state, cmd);
}

async function preflight(state) {
  const v = await runCaptured(state.gh, ['--version'], { timeoutMs: 15000 });
  if (v.code !== 0) throw new Error(`GitHub CLI unavailable: ${truncate(v.stderr || v.error || v.stdout, 2000)}`);
  const auth = await runCaptured(state.gh, ['auth','status','--hostname','github.com'], { timeoutMs: 20000 });
  if (auth.code !== 0) throw new Error(`GitHub CLI not authenticated: ${truncate(auth.stderr || auth.stdout, 3000)}`);
  // Verify command relay is readable and telemetry repo is reachable before entering loop.
  await githubGetFile(state.gh, state.config.relayRepo, state.config.relayPath, state.config.relayBranch);
  await githubGetFile(state.gh, state.config.telemetryRepo, state.config.sessionPath, state.config.telemetryBranch);
  if (IS_WIN) await startUiHelper(state);
}

async function mainLoop(state) {
  await publish(state, { forceStatus: true, reason: 'startup' });
  console.log(`\n=== CHATGPT LOCAL BRIDGE V15 READY ===`);
  console.log(`Agent version: ${VERSION}`);
  console.log(`Protocol: ${PROTOCOL}`);
  console.log(`Session publique: ${state.config.telemetryRepo}/${state.config.sessionPath}`);
  console.log(`Commande: ${state.config.relayRepo}/${state.config.relayPath}`);
  console.log(`Workspaces: ${Object.keys(state.config.allowedRoots).join(', ')}`);
  console.log(`PID: ${process.pid}`);
  console.log(`Keep this window open.\n`);

  while (!state.stopping) {
    try { await pollOnce(state); }
    catch (e) { console.error(`[${nowIso()}] poll error: ${truncate(e?.message ?? e, 3000)}`); }
    if (Date.now() - state.lastPublishedAt >= Number(state.config.heartbeatMs ?? HEARTBEAT_MS)) {
      try { await publish(state, { forceStatus: false, reason: 'heartbeat' }); }
      catch (e) { console.error(`[${nowIso()}] heartbeat error: ${truncate(e?.message ?? e, 3000)}`); }
    }
    await sleep(Number(state.config.pollMs ?? POLL_MS));
  }
}

async function runSelfTest() {
  const errors = [];
  const ok = (cond, name) => { if (!cond) errors.push(name); };
  const key = crypto.randomBytes(32);
  const sample = { hello: 'world', n: 42, nested: { ok: true } };
  try {
    const enc = encryptTelemetry(sample, key);
    ok(JSON.stringify(decryptTelemetryForSelfTest(enc, key)) === JSON.stringify(sample), 'telemetry roundtrip');
  } catch { errors.push('telemetry roundtrip threw'); }

  try {
    const resolvedDuplicate = resolveAppByName([
      { name: 'Rayman Origins', kind: 'uwp', appId: 'rayman.uwp' },
      { name: 'Rayman Origins', kind: 'shortcut', target: 'C:\\Games\\Rayman\\Rayman.exe' }
    ], 'Rayman');
    ok(resolvedDuplicate.kind === 'shortcut', 'duplicate app resolution prefers validated shortcut');
    try {
      resolveAppByName([{ name: 'Rayman Origins', kind: 'shortcut' }, { name: 'Rayman Legends', kind: 'shortcut' }], 'Rayman');
      errors.push('distinct-name ambiguity accepted');
    } catch {}
  } catch { errors.push('duplicate app resolution threw'); }

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'clb-v15-test-'));
  const root = path.join(tmp, 'root');
  await fsp.mkdir(root);
  await fsp.writeFile(path.join(root, 'a.txt'), 'hello bridge\n', 'utf8');
  try { ok((await resolveInside(root, 'a.txt')).endsWith('a.txt'), 'resolve inside'); } catch { errors.push('resolve inside threw'); }
  try { await resolveInside(root, '../escape.txt'); errors.push('path escape accepted'); } catch {}

  try {
    const state = { config: { allowedRoots: { test: root } } };
    const rr = await readFileAction(state, { workspace: 'test', relativePath: 'a.txt' });
    ok(rr.status === 'ok' && rr.data.text.includes('hello bridge'), 'read file');
    const wr = await writeFileAction(state, { workspace: 'test', relativePath: 'b.txt', text: 'ok' });
    ok(wr.status === 'ok' && (await fsp.readFile(path.join(root,'b.txt'),'utf8')) === 'ok', 'write file');
  } catch { errors.push('file actions threw'); }

  try {
    const r = await runCaptured(gitExecutable(), ['-C', root, 'status', '--short', '--branch'], { timeoutMs: 10000 });
    ok(typeof r.code === 'number' || r.error || r.code === null, 'git non-repo containment');
  } catch { errors.push('git containment threw'); }

  try {
    const apps = [{name:'Rayman Legends',kind:'shortcut'},{name:'Discord',kind:'shortcut'}];
    ok(resolveAppByName(apps,'rayman').name === 'Rayman Legends', 'app partial match');
    ok(resolveAppByName(apps,'Discord').name === 'Discord', 'app exact match');
  } catch { errors.push('app resolution threw'); }

  try {
    const fake = { sessionId: 'abc' };
    validateCommand({protocol:PROTOCOL,id:'x1',action:'status',sessionId:'abc',issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()}, fake);
  } catch { errors.push('valid command rejected'); }
  try {
    const fake = { sessionId: 'abc' };
    validateCommand({protocol:PROTOCOL,id:'x2',action:'status',sessionId:'abc',issuedAt:new Date(Date.now()-120000).toISOString(),expiresAt:new Date(Date.now()-60000).toISOString()}, fake);
    errors.push('expired command accepted');
  } catch {}

  try {
    ok(validateSafeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg>').startsWith('<svg'), 'safe svg accepted');
    try { validateSafeSvg('<svg><script>alert(1)</script></svg>'); errors.push('active svg accepted'); } catch {}
  } catch { errors.push('svg validation threw'); }

  try {
    const onePxPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9WQAAAAASUVORK5CYII=';
    const img = decodeImagePayload(onePxPng);
    ok(img.mime === 'image/png' && img.buf.length > 16, 'image payload validation');
    try { decodeImagePayload(Buffer.from('not an image').toString('base64')); errors.push('invalid image payload accepted'); } catch {}
  } catch { errors.push('image payload validation threw'); }

  try {
    ok(intField(42, 'x') === 42, 'ui coordinate validation');
    try { intField(1.5, 'x'); errors.push('fractional UI coordinate accepted'); } catch {}
  } catch { errors.push('ui coordinate validation threw'); }

  try {
    const lockDir = path.join(tmp, 'lock');
    await fsp.mkdir(lockDir);
    const lock = await acquireSingleInstance(lockDir);
    ok(fs.existsSync(lock.lockPath), 'single instance lock created');
    lock.release();
    ok(!fs.existsSync(lock.lockPath), 'single instance lock released');
  } catch { errors.push('single instance lock threw'); }

  await fsp.rm(tmp, { recursive: true, force: true });
  const report = { ok: errors.length === 0, version: VERSION, protocol: PROTOCOL, platform: process.platform, node: process.version, errors };
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}

async function main() {
  if (process.argv.includes('--self-test')) return await runSelfTest();
  const dataDir = localAppData();
  const { config, cfgPath } = await loadOrCreateConfig(dataDir);
  const instanceLock = await acquireSingleInstance(dataDir);
  const keyInfo = await loadOrCreateMasterKey(dataDir);
  const state = {
    config,
    cfgPath,
    dataDir,
    masterKey: keyInfo.key,
    gh: ghExecutable(config),
    sessionId: crypto.randomBytes(16).toString('hex'),
    startedAt: nowIso(),
    heartbeatAt: nowIso(),
    online: true,
    stopping: false,
    processedIds: new Set(),
    lastCommand: null,
    lastPublishedAt: 0,
    appCache: null,
    appCacheAt: 0,
    auditPath: path.join(dataDir, 'audit.jsonl'),
    instanceLock,
    uiHelper: null
  };

  console.log(`=== ChatGPT Local Bridge V${VERSION} ===`);
  console.log(`Node: ${process.version}`);
  console.log(`Config: ${cfgPath}`);
  console.log(`Local key: ${keyInfo.keyPath}${keyInfo.importedFrom ? ' (imported from previous bridge)' : ''}`);
  console.log(`GitHub CLI: ${state.gh}`);
  console.log(`Workspaces: ${Object.keys(config.allowedRoots).join(', ')}`);
  console.log('Preflight...');
  await preflight(state);
  console.log('Preflight: OK');

  const shutdown = async (sig) => {
    if (state.stopping) return;
    state.stopping = true; state.online = false;
    console.log(`\nStopping (${sig})...`);
    try { await publish(state, { forceStatus: true, reason: 'shutdown' }); } catch {}
    try { if (state.uiHelper?.child) state.uiHelper.child.kill(); } catch {}
  };
  process.on('SIGINT', () => { shutdown('SIGINT').finally(() => process.exit(0)); });
  process.on('SIGTERM', () => { shutdown('SIGTERM').finally(() => process.exit(0)); });
  process.on('uncaughtException', (e) => { console.error('uncaughtException:', e?.stack ?? e); });
  process.on('unhandledRejection', (e) => { console.error('unhandledRejection:', e); });

  await mainLoop(state);
}

export {
  VERSION, PROTOCOL, executeCommand, loadOrCreateConfig, localAppData, appendAudit, startUiHelper
};

function isDirectRun() {
  try {
    if (!process.argv[1]) return false;
    return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  } catch { return false; }
}

if (isDirectRun()) {
  main().catch((e) => {
    console.error('\nFATAL:', e?.stack ?? e);
    process.exitCode = 1;
  });
}
