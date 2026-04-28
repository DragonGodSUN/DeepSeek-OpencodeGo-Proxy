import http from 'node:http';
import https from 'node:https';
import { Transform } from 'node:stream';

const TARGET_HOST = 'opencode.ai';
const TARGET_PREFIX = '/zen/go';
const PROXY_PORT = 3456;

let lastReasoningContent = '';

function patchMessages(messages) {
  if (!messages) return;
  for (const msg of messages) {
    if (msg.role === 'assistant' && !('reasoning_content' in msg)) {
      if (lastReasoningContent) {
        msg.reasoning_content = lastReasoningContent;
        console.log(`  INJECTED stored reasoning_content (${lastReasoningContent.length} chars)`);
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
      port: 443,
      path: `${TARGET_PREFIX}${path}`,
      method,
      headers,
    };
    const req = https.request(opts, (res) => resolve(res));
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('upstream timeout')));
    if (body) req.write(body);
    req.end();
  });
}

function makeRCCollector() {
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
              lastReasoningContent = acc;
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
        lastReasoningContent = acc;
        console.log(`  CAPTURED reasoning_content (flush): ${acc.slice(0, 100)}...`);
      }
      cb();
    },
  });
}

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  let body = '';
  for await (const chunk of req) body += chunk;
  const ts = new Date().toISOString();
  console.log(`\n[${ts}] >>> ${req.method} ${req.url}`);

  try {
    if (body) {
      const parsed = JSON.parse(body);
      console.log(`  model: ${parsed.model}, stream: ${parsed.stream}, msgs: ${(parsed.messages || []).length}`);
      for (const m of parsed.messages || []) {
        console.log(`    [${m.role}] content:${(m.content || '').length > 100 ? (m.content || '').slice(0, 100) + '...' : (m.content || '').length} tool_calls:${m.tool_calls ? m.tool_calls.length : 0} rc:${'reasoning_content' in m}`);
      }
      patchMessages(parsed.messages);
      body = JSON.stringify(parsed);
    }

    const fwdHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding'].includes(k.toLowerCase())) {
        fwdHeaders[k] = v;
      }
    }
    fwdHeaders['content-length'] = Buffer.byteLength(body);

    console.log(`  sending to upstream (${body.length} bytes)`);
    const upstream = await forward(req.method, req.url, fwdHeaders, body);
    const status = upstream.statusCode || 500;
    console.log(`  <<< upstream: ${status}`);

    if (status >= 400) {
      let errBody = '';
      for await (const chunk of upstream) errBody += chunk;
      console.error(`  ERROR: ${errBody.slice(0, 1000)}`);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(errBody);
      return;
    }

    const respHeaders = {};
    for (const [k, v] of Object.entries(upstream.headers)) {
      if (!['transfer-encoding', 'content-length'].includes(k)) respHeaders[k] = v;
    }
    res.writeHead(status, respHeaders);

    const isStream = (upstream.headers['content-type'] || '').includes('event-stream');
    if (isStream) {
      upstream.pipe(makeRCCollector()).pipe(res);
    } else {
      upstream.pipe(res);
    }

    upstream.on('end', () => console.log(`  <<< done`));
    upstream.on('error', (e) => console.error(`  <<< error: ${e.message}`));
  } catch (err) {
    console.error(`[FATAL] ${err.message}`);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}).listen(PROXY_PORT, () => {
  console.log(`\n=== reasoning_content Proxy v2 ===`);
  console.log(`Local:  http://localhost:${PROXY_PORT}`);
  console.log(`Target: https://${TARGET_HOST}${TARGET_PREFIX}`);
  console.log(`Mode:   capture reasoning_content from SSE, inject into next request\n`);
});
