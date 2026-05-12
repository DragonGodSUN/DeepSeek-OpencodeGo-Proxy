import http from 'node:http';
import https from 'node:https';
import { Transform } from 'node:stream';
import zlib from 'node:zlib';


const TARGET_URL = process.env.TARGET_BASE_URL || 'https://opencode.ai/zen/go';
const targetUrlObj = new URL(TARGET_URL);
const TARGET_HOST = targetUrlObj.hostname;
const TARGET_PORT = targetUrlObj.port || 443;
const TARGET_BASE_PATH = targetUrlObj.pathname.replace(/\/+$/, '');
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '3456', 10);
const UPSTREAM_TIMEOUT = parseInt(process.env.UPSTREAM_TIMEOUT || '120000', 10);
const SESSION_TTL = 30 * 60 * 1000; // 30 min inactivity cleanup

// Model name mapping: MODEL_MAP='{"deepseek-v4-flash":"deepseek-v4-pro"}'
let MODEL_MAP = {};
if (process.env.MODEL_MAP) {
  try { MODEL_MAP = JSON.parse(process.env.MODEL_MAP); } catch { console.error('Invalid MODEL_MAP JSON'); }
}

// --- Session store ---
const sessions = new Map();

function getOrCreateSession(req) {
  let sid = req.headers['x-session-id']
    || req.headers['x-claude-code-session-id']
    || req.headers['authorization']?.replace(/^Bearer\s+/i, '').slice(-12)
    || '__default__';
  let s = sessions.get(sid);
  if (!s) {
    s = { lastReasoningContent: '', createdAt: Date.now(), lastAccessAt: Date.now() };
    sessions.set(sid, s);
  }
  s.lastAccessAt = Date.now();
  return { sid, session: s };
}

// Periodic cleanup of stale sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastAccessAt > SESSION_TTL) sessions.delete(id);
  }
}, 60_000);

// --- Helpers ---

function patchMessages(messages, session) {
  if (!messages) return;
  for (const msg of messages) {
    if (msg.role === 'assistant' && !('reasoning_content' in msg)) {
      if (session.lastReasoningContent) {
        msg.reasoning_content = session.lastReasoningContent;
        console.log(`  INJECTED stored reasoning_content (${session.lastReasoningContent.length} chars)`);
      } else {
        msg.reasoning_content = null;
      }
    }
  }
}

function forward(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: TARGET_HOST,
      port: TARGET_PORT,
      path: `${TARGET_BASE_PATH}${path.replace(/^\/(?!v\d\/)/, '/v1/')}`,
      method,
      headers,
    };
    const req = https.request(opts, (res) => resolve(res));
    req.on('error', reject);
    req.setTimeout(UPSTREAM_TIMEOUT, () => req.destroy(new Error('upstream timeout')));
    if (body) req.write(body);
    req.end();
  });
}

function makeRCCollector(session) {
  let buf = '';
  let acc = '';
  return new Transform({
    transform(chunk, _, cb) {
      const raw = chunk.toString();
      this.push(chunk);
      buf += raw;
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (t.startsWith('data: ') && !t.includes('[DONE]')) {
          try {
            const data = JSON.parse(t.slice(6));
            const rc = data.choices?.[0]?.delta?.reasoning_content;
            if (rc) acc += rc;
            if (data.choices?.[0]?.finish_reason === 'stop' && acc) {
              session.lastReasoningContent = acc;
              console.log(`  CAPTURED reasoning_content: ${acc.slice(0, 100)}...`);
              acc = '';
            }
          } catch {}
        }
      }
      cb();
    },
    flush(cb) {
      if (acc) {
        session.lastReasoningContent = acc;
        console.log(`  CAPTURED reasoning_content (flush): ${acc.slice(0, 100)}...`);
      }
      cb();
    },
  });
}

// --- Server ---

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const { sid, session } = getOrCreateSession(req);
  res.setHeader('x-session-id', sid);

  let body = '';
  for await (const chunk of req) body += chunk;
  const ts = new Date().toISOString();
  console.log(`\n[${ts}] [${sid.slice(0, 8)}] >>> ${req.method} ${req.url}`);
  for (const [k, v] of Object.entries(req.headers)) {
    if (!['host', 'connection', 'content-length', 'transfer-encoding'].includes(k.toLowerCase())) {
      console.log(`  HDR ${k}: ${v}`);
    }
  }

  try {
    if (body) {
      const parsed = JSON.parse(body);
      if (MODEL_MAP[parsed.model]) {
        console.log(`  model mapped: ${parsed.model} -> ${MODEL_MAP[parsed.model]}`);
        parsed.model = MODEL_MAP[parsed.model];
      }
      console.log(`  model: ${parsed.model}, stream: ${parsed.stream}, msgs: ${(parsed.messages || []).length}`);
      for (const m of parsed.messages || []) {
        console.log(`    [${m.role}] content:${(m.content || '').length > 100 ? (m.content || '').slice(0, 100) + '...' : (m.content || '').length} tool_calls:${m.tool_calls ? m.tool_calls.length : 0} rc:${'reasoning_content' in m}`);
      }
      patchMessages(parsed.messages, session);
      if (parsed.tool_choice) {
        console.log(`  stripped tool_choice: ${JSON.stringify(parsed.tool_choice)}`);
        delete parsed.tool_choice;
      }
      body = JSON.stringify(parsed);
    }

    const fwdHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!['host', 'connection', 'content-length', 'transfer-encoding'].includes(k.toLowerCase())) {
        fwdHeaders[k] = v;
      }
    }
    fwdHeaders['content-length'] = Buffer.byteLength(body);

    console.log(`  sending to upstream (${body.length} bytes)`);
    const upstreamRes = await forward(req.method, req.url, fwdHeaders, body);
    const status = upstreamRes.statusCode || 500;
    console.log(`  <<< upstream: ${status}`);

    if (status >= 400) {
      let errBody = '';
      for await (const chunk of upstreamRes) errBody += chunk;
      console.error(`  ERROR: ${errBody.slice(0, 1000)}`);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(errBody);
      return;
    }

    // Decompress upstream response if needed
    const contentEncoding = upstreamRes.headers['content-encoding'];
    let upstreamStream = upstreamRes;
    if (contentEncoding === 'gzip') {
      upstreamStream = upstreamRes.pipe(zlib.createGunzip());
    } else if (contentEncoding === 'deflate') {
      upstreamStream = upstreamRes.pipe(zlib.createInflate());
    } else if (contentEncoding) {
      console.log(`  unknown content-encoding: ${contentEncoding}`);
    }

    // Build response headers (strip transfer-encoding of upstream)
    const respHeaders = {};
    for (const [k, v] of Object.entries(upstreamRes.headers)) {
      if (!['transfer-encoding', 'content-length', 'content-encoding'].includes(k)) respHeaders[k] = v;
    }
    res.writeHead(status, respHeaders);

    const isStream = (upstreamRes.headers['content-type'] || '').includes('event-stream');
    if (isStream) {
      upstreamStream.pipe(makeRCCollector(session)).pipe(res);
    } else {
      // Non-streaming: collect full response, extract reasoning_content, then forward
      let buf = '';
      upstreamStream.on('data', (chunk) => { buf += chunk; });
      upstreamStream.on('end', () => {
        try {
          const json = JSON.parse(buf);
          const rc = json.choices?.[0]?.message?.reasoning_content;
          if (rc) {
            session.lastReasoningContent = rc;
            console.log(`  CAPTURED (non-stream): ${rc.slice(0, 100)}...`);
          }
        } catch {}
        res.end(buf);
      });
    }

    upstreamRes.on('end', () => console.log(`  <<< done`));
    upstreamRes.on('error', (e) => console.error(`  <<< error: ${e.message}`));
  } catch (err) {
    console.error(`[FATAL] ${err.message}`);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}).listen(PROXY_PORT, () => {
  console.log(`\n=== reasoning_content Proxy v3 ===`);
  console.log(`Local:  http://localhost:${PROXY_PORT}`);
  console.log(`Target: ${TARGET_URL}`);
  console.log(`Timeout: ${UPSTREAM_TIMEOUT}ms`);
  console.log(`Multisession: enabled`);
  console.log(`Compression: supported`);
  console.log(`Non-streaming: supported\n`);
});
