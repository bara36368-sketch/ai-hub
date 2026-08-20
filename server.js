const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { execSync, exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 8765;
const DATA_DIR = path.join(__dirname, 'data');
const PROVIDERS_FILE = path.join(__dirname, 'providers.json');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');
const MODELS_FILE = path.join(DATA_DIR, 'models.json');
const WORKSPACE = process.env.WORKSPACE || path.join(__dirname, '..', 'opencode-server-bot');

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============ PROVIDER MANAGEMENT ============
let providersConfig = JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8'));
let userKeys = fs.existsSync(KEYS_FILE) ? JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')) : {};
let modelCache = fs.existsSync(MODELS_FILE) ? JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8')) : {};

let provCache = { data: null, ts: 0 };
const CACHE_MS = 30000;

function getProviders() {
  return providersConfig.providers.map(p => ({
    ...p, key: userKeys[p.id] || p.key, status: 'unknown', latency: 0, models: [], knownModels: p.knownModels || []
  })).sort((a, b) => a.priority - b.priority);
}

async function checkOne(p) {
  const t = Date.now();
  try {
    const modelsUrl = p.models_url || p.url.replace('/chat/completions', '/models');
    if (!modelsUrl || !modelsUrl.startsWith('http')) {
      return { ...p, status: p.enabled ? 'online' : 'disabled', latency: 0, models: p.knownModels || [] };
    }
    const h = {}; if (p.key) h['Authorization'] = `Bearer ${p.key}`;
    const r = await fetch(modelsUrl, { headers: h, signal: AbortSignal.timeout(3000) });
    const ms = Date.now() - t;
    if (r.ok) {
      const d = await r.json();
      const models = (d.data || []).map(m => m.id || m.name).filter(Boolean);
      return { ...p, status: 'online', latency: ms, models: models.slice(0, 50) };
    }
    return { ...p, status: 'error', latency: ms, models: p.knownModels || [] };
  } catch {
    return { ...p, status: 'offline', latency: Date.now() - t, models: p.knownModels || [] };
  }
}

async function refreshAll() {
  const ps = getProviders();
  const results = await Promise.allSettled(ps.map(checkOne));
  provCache = { data: results.map(c => c.value || c.reason), ts: Date.now() };
}

refreshAll().then(() => {
  const on = provCache.data.filter(p => p.status === 'online').length;
  console.log(`[cache] Warmed: ${on}/${provCache.data.length} online`);
}).catch(() => {});

// ============ MODEL SCANNER ============
// Test each model with a tiny chat request
async function scanModel(provider, model) {
  const t = Date.now();
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (provider.key) headers['Authorization'] = `Bearer ${provider.key}`;
    const body = { model, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 5, temperature: 0 };
    const r = await fetch(provider.url, {
      method: 'POST', headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000)
    });
    const ms = Date.now() - t;
    if (r.ok) {
      const d = await r.json();
      if (d.choices && d.choices[0]) {
        return { model, status: 'working', latency: ms, response: d.choices[0].message?.content?.substring(0, 50) || '' };
      }
    }
    const err = await r.text().catch(() => '');
    return { model, status: 'broken', latency: ms, error: `HTTP ${r.status}: ${err.substring(0, 100)}` };
  } catch (e) {
    return { model, status: 'broken', latency: Date.now() - t, error: e.message };
  }
}

// Scan all models for a provider
let scanRunning = false;
app.post('/api/scan', async (req, res) => {
  if (scanRunning) return res.status(429).json({ error: 'Scan already running' });
  scanRunning = true;
  const { providerId } = req.body;

  try {
    const cached = provCache.data || [];
    const providers = cached.filter(p => p.enabled && p.status !== 'offline');
    const targets = providerId ? providers.filter(p => p.id === providerId) : providers;
    const results = {};

    for (const p of targets) {
      const models = (p.models || p.knownModels || []).slice(0, 15);
      if (!models.length) {
        results[p.id] = { provider: p.name, models: [] };
        continue;
      }
      // Scan models in parallel (10 at a time)
      const modelResults = [];
      for (let i = 0; i < models.length; i += 10) {
        const batch = models.slice(i, i + 10);
        const batchResults = await Promise.allSettled(batch.map(m => scanModel(p, m)));
        modelResults.push(...batchResults.map(r => r.value || { model: '?', status: 'error', error: 'timeout' }));
      }
      results[p.id] = { provider: p.name, models: modelResults };
    }

    modelCache = { results, lastScan: new Date().toISOString() };
    fs.writeFileSync(MODELS_FILE, JSON.stringify(modelCache, null, 2));
    res.json(modelCache);
  } finally {
    scanRunning = false;
  }
});

app.get('/api/scan', (req, res) => res.json(modelCache));

// ============ PHONE CONTROL ============
// Execute commands on phone via ADB or Termux SSH
let phoneConnection = { connected: false, method: null, ip: null };

app.post('/api/phone/connect', async (req, res) => {
  const { ip, method } = req.body; // method: 'adb' or 'ssh' or 'http'
  phoneConnection = { connected: false, method, ip };

  if (method === 'http') {
    // Simple HTTP check
    try {
      const r = await fetch(`http://${ip}:8080/ping`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        phoneConnection.connected = true;
        return res.json({ ok: true, method: 'http', ip });
      }
    } catch {}
    return res.json({ ok: false, error: 'Phone not reachable on port 8080' });
  }

  if (method === 'adb') {
    try {
      execSync(`adb connect ${ip}:5555`, { timeout: 5000 });
      phoneConnection.connected = true;
      return res.json({ ok: true, method: 'adb', ip });
    } catch (e) {
      return res.json({ ok: false, error: e.message });
    }
  }

  if (method === 'ssh') {
    // Try SSH with key auth (Termux)
    try {
      execSync(`ssh -o ConnectTimeout=3 -o BatchMode=yes ${ip} "echo ok"`, { timeout: 5000 });
      phoneConnection.connected = true;
      return res.json({ ok: true, method: 'ssh', ip });
    } catch (e) {
      return res.json({ ok: false, error: 'SSH failed. Set up key auth: ssh-copy-id ' + ip });
    }
  }

  res.json({ ok: false, error: 'Unknown method' });
});

app.get('/api/phone/status', (req, res) => res.json(phoneConnection));

app.post('/api/phone/command', async (req, res) => {
  const { command } = req.body;
  if (!phoneConnection.connected) return res.status(400).json({ error: 'Phone not connected' });

  const { method, ip } = phoneConnection;

  if (method === 'adb') {
    try {
      const output = execSync(`adb -s ${ip}:5555 shell "${command}"`, { timeout: 10000, encoding: 'utf8' });
      res.json({ ok: true, output });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
    return;
  }

  if (method === 'ssh') {
    try {
      const output = execSync(`ssh -o ConnectTimeout=5 ${ip} "${command}"`, { timeout: 10000, encoding: 'utf8' });
      res.json({ ok: true, output });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
    return;
  }

  res.status(400).json({ error: 'Unsupported method for commands' });
});

app.get('/api/phone/files', async (req, res) => {
  const dir = req.query.dir || '/sdcard';
  if (!phoneConnection.connected) return res.status(400).json({ error: 'Phone not connected' });

  const { method, ip } = phoneConnection;

  if (method === 'adb') {
    try {
      const output = execSync(`adb -s ${ip}:5555 shell "ls -la '${dir}'"`, { timeout: 5000, encoding: 'utf8' });
      const files = output.trim().split('\n').filter(Boolean).slice(1).map(line => {
        const parts = line.split(/\s+/);
        const isDir = parts[0]?.startsWith('d');
        const name = parts.slice(8).join(' ');
        return { name, isDir, permissions: parts[0], size: parts[4] };
      });
      res.json({ dir, files });
    } catch (e) {
      res.json({ dir, files: [], error: e.message });
    }
    return;
  }

  res.status(400).json({ error: 'Unsupported' });
});

app.get('/api/phone/info', async (req, res) => {
  if (!phoneConnection.connected) return res.json({ connected: false });

  const { method, ip } = phoneConnection;
  if (method === 'adb') {
    try {
      const model = execSync(`adb -s ${ip}:5555 shell getprop ro.product.model`, { timeout: 3000, encoding: 'utf8' }).trim();
      const android = execSync(`adb -s ${ip}:5555 shell getprop ro.build.version.release`, { timeout: 3000, encoding: 'utf8' }).trim();
      const battery = execSync(`adb -s ${ip}:5555 shell dumpsys battery | findstr "level"`, { timeout: 3000, encoding: 'utf8' }).trim();
      const storage = execSync(`adb -s ${ip}:5555 shell df /sdcard | tail -1`, { timeout: 3000, encoding: 'utf8' }).trim();
      const wifi = execSync(`adb -s ${ip}:5555 shell dumpsys wifi | findstr "mWifiInfo"`, { timeout: 3000, encoding: 'utf8' }).trim();
      const screen = execSync(`adb -s ${ip}:5555 shell wm size`, { timeout: 3000, encoding: 'utf8' }).trim();
      const cpu = execSync(`adb -s ${ip}:5555 shell cat /proc/cpuinfo | findstr "Hardware"`, { timeout: 3000, encoding: 'utf8' }).trim();
      const ram = execSync(`adb -s ${ip}:5555 shell cat /proc/meminfo | findstr "MemTotal"`, { timeout: 3000, encoding: 'utf8' }).trim();
      res.json({ connected: true, model, android, battery, storage, wifi, screen, cpu, ram });
    } catch (e) {
      res.json({ connected: true, error: e.message });
    }
    return;
  }

  if (method === 'ssh') {
    try {
      const model = execSync(`ssh ${ip} "getprop ro.product.model 2>/dev/null || uname -m"`, { timeout: 3000, encoding: 'utf8' }).trim();
      const storage = execSync(`ssh ${ip} "df /sdcard 2>/dev/null | tail -1 || df -h | tail -1"`, { timeout: 3000, encoding: 'utf8' }).trim();
      const ram = execSync(`ssh ${ip} "cat /proc/meminfo 2>/dev/null | head -1 || free -h | head -2"`, { timeout: 3000, encoding: 'utf8' }).trim();
      const battery = execSync(`ssh ${ip} "cat /sys/class/power_supply/battery/capacity 2>/dev/null || echo 'N/A'"`, { timeout: 3000, encoding: 'utf8' }).trim();
      const uptime = execSync(`ssh ${ip} "uptime -p 2>/dev/null || uptime"`, { timeout: 3000, encoding: 'utf8' }).trim();
      res.json({ connected: true, model, storage, ram, battery, uptime });
    } catch (e) {
      res.json({ connected: true, error: e.message });
    }
    return;
  }

  res.json({ connected: false });
});

// ============ API ROUTES ============
app.get('/api/providers', (req, res) => {
  const force = req.query.force === '1';
  if (provCache.data && !force) {
    res.json(provCache.data);
    if (Date.now() - provCache.ts > CACHE_MS) refreshAll().catch(() => {});
    return;
  }
  res.json([]);
});

app.get('/api/providers/:id/check', async (req, res) => {
  const providers = getProviders();
  const provider = providers.find(p => p.id === req.params.id);
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  const result = await checkOne(provider);
  res.json({ ...provider, ...result });
});

app.post('/api/keys', (req, res) => {
  const { providerId, key } = req.body;
  if (!providerId) return res.status(400).json({ error: 'providerId required' });
  userKeys[providerId] = key;
  fs.writeFileSync(KEYS_FILE, JSON.stringify(userKeys, null, 2));
  res.json({ ok: true });
});

app.get('/api/keys', (req, res) => {
  const result = {};
  for (const [id, key] of Object.entries(userKeys)) {
    result[id] = key ? key.substring(0, 8) + '...' + key.substring(key.length - 4) : '';
  }
  res.json(result);
});

app.post('/api/providers/custom', (req, res) => {
  const { id, name, url, key, type } = req.body;
  if (!id || !url) return res.status(400).json({ error: 'id and url required' });
  if (providersConfig.providers.find(p => p.id === id)) return res.status(409).json({ error: 'Already exists' });
  providersConfig.providers.push({
    id, name: name || id, type: type || 'openai',
    url, models_url: url.replace('/chat/completions', '/models'),
    key: key || '', enabled: true, free: true, priority: 99
  });
  if (key) userKeys[id] = key;
  fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(providersConfig, null, 2));
  fs.writeFileSync(KEYS_FILE, JSON.stringify(userKeys, null, 2));
  res.json({ ok: true });
});

app.delete('/api/providers/:id', (req, res) => {
  const idx = providersConfig.providers.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  providersConfig.providers.splice(idx, 1);
  delete userKeys[req.params.id];
  fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(providersConfig, null, 2));
  fs.writeFileSync(KEYS_FILE, JSON.stringify(userKeys, null, 2));
  res.json({ ok: true });
});

app.post('/api/providers/:id/toggle', (req, res) => {
  const provider = providersConfig.providers.find(p => p.id === req.params.id);
  if (!provider) return res.status(404).json({ error: 'Not found' });
  provider.enabled = !provider.enabled;
  fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(providersConfig, null, 2));
  res.json({ ok: true, enabled: provider.enabled });
});

// ============ GALAXY ============
const GALAXY_CATALOG = [
  { id:'omniroute', name:'OmniRoute', desc:'271 providers, auto-routes free models', stars:0, url:'https://github.com', type:'proxy', api:'http://localhost:20128/v1/chat/completions', models:'http://localhost:20128/v1/models', status:'local', note:'Routes across 271 free providers.' },
  { id:'freellmapi', name:'FreeLLMAPI', desc:'191 free models, auto-routing', stars:0, url:'https://github.com', type:'proxy', api:'http://localhost:3001/v1/chat/completions', models:'http://localhost:3001/v1/models', status:'local', note:'191 models from multiple providers.' },
  { id:'freedeepseek', name:'FreeDeepseekAPI', desc:'DeepSeek V4 free access', stars:0, url:'https://github.com', type:'proxy', api:'http://localhost:9655/v1/chat/completions', models:'http://localhost:9655/v1/models', status:'local', note:'DeepSeek V4 models.' },
  { id:'cliproxyapi', name:'CLIProxyAPI', desc:'Kimi K3, Gemini, Claude free', stars:0, url:'https://github.com', type:'proxy', api:'http://localhost:8317/v1/chat/completions', models:'http://localhost:8317/v1/models', status:'local', note:'8 models via OAuth.' },
  { id:'freeloader', name:'Freeloader', desc:'177+ free providers, cascading', stars:0, url:'https://github.com/Arnav8452/Freeloader', type:'gateway', api:'http://localhost:4141/v1/chat/completions', models:'http://localhost:4141/v1/models', status:'install', note:'Docker. Smart routing with circuit breakers.' },
  { id:'litellm-proxy', name:'LiteLLM Free Proxy', desc:'Auto-discovers free models from 12+ providers', stars:0, url:'https://github.com/tomaasz/litellm-free-models-proxy', type:'gateway', api:'http://localhost:4000/v1/chat/completions', models:'http://localhost:4000/v1/models', status:'install', note:'Docker. Auto-discovers free models every 8h.' },
  { id:'llmproxy', name:'LLMProxy', desc:'24 providers, 6-layer defense', stars:0, url:'https://github.com/fabriziosalmi/llmproxy', type:'gateway', api:'http://localhost:8090/v1/chat/completions', models:'http://localhost:8090/v1/models', status:'install', note:'Python. Cost-aware routing, budget limits.' },
  { id:'ai-proxy-gateway', name:'AI Proxy Gateway', desc:'One-command local proxy', stars:0, url:'https://github.com/mrbeandev/ai-proxy-gateway', type:'gateway', api:'http://localhost:4141/v1/chat/completions', models:'http://localhost:4141/v1/models', status:'install', note:'npx ai-proxy-gateway. Dashboard included.' },
  { id:'owl-orca', name:'OWL-ORCA', desc:'Stream racing, protocol translation', stars:0, url:'https://github.com/marktantongco/owl-orca', type:'gateway', api:'http://localhost:8080/v1/chat/completions', models:'http://localhost:8080/v1/models', status:'install', note:'Races providers. First byte wins.' },
  { id:'phi-gateway', name:'Phi Gateway', desc:'LLM proxy + RAG + tool registry', stars:0, url:'https://github.com/raindragon14/phi-gateway', type:'gateway', api:'http://localhost:8000/v1/chat/completions', models:'http://localhost:8000/v1/models', status:'install', note:'FastAPI. Chat + RAG + agent memory.' },
  { id:'gproxy', name:'GPROXY', desc:'Rust multi-channel LLM proxy', stars:0, url:'https://github.com/LeenHawk/gproxy', type:'gateway', api:'http://localhost:8080/v1/chat/completions', models:'http://localhost:8080/v1/models', status:'install', note:'Rust. Admin console, key management.' },
  { id:'open-webui', name:'Open WebUI', desc:'Most popular self-hosted AI (149K stars)', stars:149000, url:'https://github.com/open-webui/open-webui', type:'webui', api:'http://localhost:3000/api/chat/completions', models:'http://localhost:3000/api/models', status:'install', note:'pip install open-webui. Full ChatGPT replacement.' },
  { id:'nextchat', name:'NextChat', desc:'Lightest ChatGPT clone (88K stars, 5MB)', stars:88500, url:'https://github.com/ChatGPTNextWeb/NextChat', type:'webui', api:'http://localhost:3000/v1/chat/completions', models:'http://localhost:3000/v1/models', status:'install', note:'One-click Vercel deploy.' },
  { id:'lobechat', name:'LobeChat', desc:'Polished AI workspace (80K stars)', stars:80000, url:'https://github.com/lobehub/lobe-chat', type:'webui', api:'http://localhost:3210/v1/chat/completions', models:'http://localhost:3210/v1/models', status:'install', note:'Docker. 100+ plugins.' },
  { id:'gpt-academic', name:'GPT Academic', desc:'Academic paper optimization (71K stars)', stars:71000, url:'https://github.com/binary-husky/gpt_academic', type:'webui', api:'http://localhost:8080/v1/chat/completions', models:'http://localhost:8080/v1/models', status:'install', note:'Python. GPT, Azure, Qwen, GLM.' },
  { id:'anythingllm', name:'AnythingLLM', desc:'Private ChatGPT with RAG (65K stars)', stars:65000, url:'https://github.com/Mintplex-Labs/anything-llm', type:'webui', api:'http://localhost:3001/api/v1/chat/completions', models:'http://localhost:3001/api/v1/models', status:'install', note:'Docker. Document ingestion, RAG.' },
  { id:'privategpt', name:'PrivateGPT', desc:'API for private AI apps (57K stars)', stars:57000, url:'https://github.com/zylon-ai/private-gpt', type:'webui', api:'http://localhost:8001/v1/chat/completions', models:'http://localhost:8001/v1/models', status:'install', note:'Python. RAG, tools, MCP.' },
  { id:'localai', name:'LocalAI', desc:'OpenAI drop-in, no GPU needed (48K stars)', stars:48500, url:'https://github.com/mudler/LocalAI', type:'gateway', api:'http://localhost:8080/v1/chat/completions', models:'http://localhost:8080/v1/models', status:'install', note:'Docker. 60+ backends, CPU-only.' },
  { id:'nanobot', name:'nanobot', desc:'Lightweight AI agent with WebUI (47K stars)', stars:47000, url:'https://github.com/HKUDS/nanobot', type:'webui', api:'http://localhost:8080/v1/chat/completions', models:'http://localhost:8080/v1/models', status:'install', note:'Python. WebUI, tools, MCP.' },
  { id:'jan', name:'Jan', desc:'100% offline ChatGPT (44K stars)', stars:44000, url:'https://github.com/janhq/jan', type:'webui', api:'http://localhost:1337/v1/chat/completions', models:'http://localhost:1337/v1/models', status:'install', note:'Desktop app. Downloads models from HF.' },
  { id:'librechat', name:'LibreChat', desc:'Enhanced ChatGPT clone (42K stars)', stars:42000, url:'https://github.com/danny-avila/LibreChat', type:'webui', api:'http://localhost:3080/v1/chat/completions', models:'http://localhost:3080/v1/models', status:'install', note:'Docker. Multi-provider, agents.' },
  { id:'chatbox', name:'Chatbox', desc:'Cross-platform AI client (41K stars)', stars:41500, url:'https://github.com/chatboxai/chatbox', type:'webui', api:'http://localhost:3000/v1/chat/completions', models:'http://localhost:3000/v1/models', status:'install', note:'Desktop + Mobile. All providers.' },
  { id:'khoj', name:'Khoj', desc:'AI second brain (36K stars)', stars:36500, url:'https://github.com/khoj-ai/khoj', type:'webui', api:'http://localhost:8080/api/chat/completions', models:'http://localhost:8080/api/models', status:'install', note:'Docker. Semantic search, RAG.' },
  { id:'sillytavern', name:'SillyTavern', desc:'LLM frontend for power users (31K stars)', stars:31000, url:'https://github.com/sillytavern/SillyTavern', type:'webui', api:'http://localhost:8000/v1/chat/completions', models:'http://localhost:8000/v1/models', status:'install', note:'Node.js. Character cards, extensions.' },
  { id:'huggingchat', name:'HuggingChat', desc:'Free hosted at hf.co/chat (11K stars)', stars:10900, url:'https://github.com/huggingface/chat-ui', type:'public', api:'https://huggingface.co/chat/v1/chat/completions', models:'https://huggingface.co/chat/v1/models', status:'online', note:'Public instance. Free, no key needed.' },
];

app.get('/api/galaxy', (req, res) => {
  const installed = providersConfig.providers.map(p => p.id);
  res.json(GALAXY_CATALOG.map(item => ({ ...item, installed: installed.includes(item.id), hasApi: !!(item.api && item.api.startsWith('http')) })));
});

app.post('/api/galaxy/load', (req, res) => {
  const { id } = req.body;
  const item = GALAXY_CATALOG.find(g => g.id === id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (providersConfig.providers.find(p => p.id === item.id)) return res.json({ ok: true, message: 'Already loaded' });
  providersConfig.providers.push({ id: item.id, name: item.name, type: 'openai', url: item.api, models_url: item.models || '', key: '', enabled: true, free: true, priority: 50 });
  fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(providersConfig, null, 2));
  refreshAll().catch(() => {});
  res.json({ ok: true, message: 'Loaded ' + item.name });
});

// ============ CHAT (ROUTER) ============
app.post('/v1/chat/completions', async (req, res) => {
  const cached = provCache.data || [];
  const providers = cached.filter(p => p.enabled && p.status !== 'offline');
  let lastError;

  for (const prov of providers) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (prov.key) headers['Authorization'] = `Bearer ${prov.key}`;
      const body = { ...req.body };

      // If model is 'auto' or not specified, use first known model
      if (!body.model || body.model === 'auto') {
        const models = prov.models || prov.knownModels || [];
        if (models.length > 0) body.model = models[0];
        else delete body.model;
      }

      const response = await fetch(prov.url, {
        method: 'POST', headers, body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000)
      });

      if (response.ok) {
        const data = await response.json();
        if (data.choices && data.choices.length) {
          res.setHeader('X-Provider', prov.id);
          res.setHeader('X-Model', body.model || 'unknown');
          return res.json(data);
        }
      }
      lastError = `${prov.name}(${body.model || '?'}): HTTP ${response.status}`;
    } catch (e) {
      lastError = `${prov.name}: ${e.message}`;
    }
  }

  res.status(502).json({ error: 'All providers failed', lastError });
});

// ============ FILE MANAGER ============
app.get('/api/files', (req, res) => {
  const dir = req.query.dir || WORKSPACE;
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    const files = items.filter(i => !i.name.startsWith('.') || req.query.all === '1').map(item => {
      const fullPath = path.join(dir, item.name);
      let stats; try { stats = fs.statSync(fullPath); } catch { stats = null; }
      return { name: item.name, isDirectory: item.isDirectory(), size: stats?.size || 0, modified: stats?.mtime, path: fullPath };
    });
    res.json({ dir, files: files.sort((a, b) => b.isDirectory - a.isDirectory || a.name.localeCompare(b.name)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/files/read', (req, res) => {
  if (!req.query.path) return res.status(400).json({ error: 'path required' });
  try { res.json({ path: req.query.path, content: fs.readFileSync(req.query.path, 'utf8') }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/files/write', (req, res) => {
  const { path: filePath, content } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  try { fs.writeFileSync(filePath, content, 'utf8'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ AI CODE EDITOR ============
app.post('/api/ai/chat', async (req, res) => {
  const { messages, workspace } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'messages required' });
  const ws = workspace || WORKSPACE;
  const systemMsg = {
    role: 'system',
    content: `You are an expert AI coding assistant. WORKSPACE: ${ws}. Read, write, create, edit files. Return actions as JSON: {"action":"write","path":"...","content":"..."} or {"action":"edit","path":"...","old":"...","new":"..."}. Be helpful and write clean code.`
  };
  try {
    const providers = getProviders().filter(p => p.enabled && p.status !== 'offline');
    for (const prov of providers) {
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (prov.key) headers['Authorization'] = `Bearer ${prov.key}`;
        const models = prov.models || prov.knownModels || [];
        const body = { model: models[0] || 'auto', messages: [systemMsg, ...messages], max_tokens: 4096 };
        const r = await fetch(prov.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
        if (r.ok) { const d = await r.json(); if (d.choices?.length) return res.json(d.choices[0].message); }
      } catch {}
    }
    res.status(502).json({ error: 'No provider available' });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ============ NETWORK INFO ============
app.get('/api/network', (req, res) => {
  const os = require('os');
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) ips.push({ name, address: net.address });
    }
  }
  res.json({ ips, hostname: os.hostname(), port: PORT });
});

app.get('/api/system', (req, res) => {
  const os = require('os');
  res.json({
    hostname: os.hostname(), platform: os.platform(), arch: os.arch(),
    cpus: os.cpus().length, totalMem: Math.round(os.totalmem() / 1024 / 1024),
    freeMem: Math.round(os.freemem() / 1024 / 1024), uptime: Math.round(os.uptime() / 3600),
    nodeVersion: process.version, workspace: WORKSPACE
  });
});

// ============ START ============
app.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  let localIP = 'localhost';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) { localIP = net.address; break; }
    }
  }
  console.log(`\n  ╔══════════════════════════════════════════════════╗`);
  console.log(`  ║            AI HUB - Universal AI Gateway          ║`);
  console.log(`  ╠══════════════════════════════════════════════════╣`);
  console.log(`  ║  PC:      http://localhost:${PORT}                  ║`);
  console.log(`  ║  Phone:   http://${localIP}:${PORT}         ║`);
  console.log(`  ║  API:     http://localhost:${PORT}/v1                ║`);
  console.log(`  ║  Galaxy:  http://localhost:${PORT} → 🌌             ║`);
  console.log(`  ╚══════════════════════════════════════════════════╝\n`);
});
