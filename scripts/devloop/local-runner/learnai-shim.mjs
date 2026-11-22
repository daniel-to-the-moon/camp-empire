// camp-empire 本机 runner：Codex → LearnAI 网关的兼容垫片（只监听 127.0.0.1）。
// 网关拒收 Codex 默认带的几个 Responses API 字段（2026-11-22 逐项实测，Codex CLI 0.107.0）：
//   INVALID_REQUEST：prompt_cache_key、client_metadata、reasoning 为 null 或带 context、include reasoning.encrypted_content、
//                    回放的 assistant 消息上的 phase 字段；UNSUPPORTED_REQUEST：custom / web_search 等非 function 工具。
// 这里只删掉这些字段（缺省时补 reasoning.effort=high），其余原样转发（含流式）。
// 新版 Codex（0.171）把工具放进 input 的 additional_tools 项、主工具是 custom exec（code mode），网关无法支持，所以本机固定用 0.107.0。
// 不记录请求头与 key；日志只写字段名与上游错误码。
import http from 'node:http';

const UPSTREAM = new URL(process.env.LEARNAI_UPSTREAM || 'http://127.0.0.1:46215');
const PORT = Number(process.env.SHIM_PORT || 46290);
const DROP = ['prompt_cache_key', 'client_metadata', 'safety_identifier', 'service_tier'];
const log = (...a) => console.log(new Date().toISOString(), ...a);

function rewrite(buf) {
  let j;
  try { j = JSON.parse(buf.toString('utf8')); } catch { return buf; }
  const dropped = [];
  for (const k of DROP) if (k in j) { delete j[k]; dropped.push(k); }
  // reasoning：网关拒收 null 与 context 字段；缺省时补 effort=high（Codex 不认识该模型时不带 effort）
  if (j.reasoning == null) { if ('reasoning' in j) dropped.push('reasoning:null'); j.reasoning = { effort: process.env.SHIM_EFFORT || 'high' }; }
  else if (typeof j.reasoning === 'object' && 'context' in j.reasoning) { delete j.reasoning.context; dropped.push('reasoning.context'); }
  if (Array.isArray(j.include)) { j.include = j.include.filter((x) => x !== 'reasoning.encrypted_content'); if (!j.include.length) delete j.include; dropped.push('include'); }
  // 上一轮回放的 reasoning 项没有加密内容，网关无法复用：去掉
  // 回放的 assistant 消息带 phase 字段，网关报 INVALID_REQUEST
  if (Array.isArray(j.input)) for (const it of j.input) if (it && typeof it === 'object' && 'phase' in it) delete it.phase;
  if (Array.isArray(j.input)) { const n = j.input.length; j.input = j.input.filter((it) => it?.type !== 'reasoning'); if (j.input.length !== n) dropped.push(`input.reasoning×${n - j.input.length}`); }
  if (Array.isArray(j.tools)) {
    const before = j.tools.length;
    const kept = j.tools.filter((t) => t && t.type === 'function');
    if (kept.length !== before) dropped.push(`tools:${j.tools.filter((t) => t?.type !== 'function').map((t) => `${t.type}:${t.name ?? ''}`).join(',')}`);
    j.tools = kept;
    if (!kept.length) { delete j.tools; delete j.tool_choice; delete j.parallel_tool_calls; }
  }
  log('req', Object.keys(j).join(','), dropped.length ? `dropped=${dropped.join(';')}` : '');
  return Buffer.from(JSON.stringify(j));
}

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = Buffer.concat(chunks);
    if (req.method === 'POST' && /\/responses$/.test(req.url || '')) body = rewrite(body);
    const headers = { ...req.headers, host: UPSTREAM.host, 'content-length': String(body.length) };
    delete headers['accept-encoding'];
    const up = http.request({ hostname: UPSTREAM.hostname, port: UPSTREAM.port, path: req.url, method: req.method, headers }, (ur) => {
      if ((ur.statusCode || 0) >= 400) {
        const e = [];
        ur.on('data', (c) => e.push(c));
        ur.on('end', () => {
          const t = Buffer.concat(e);
          log('upstream', ur.statusCode, t.toString('utf8').slice(0, 300).replace(/lai_[A-Za-z0-9_-]+/g, 'lai_***'));
          res.writeHead(ur.statusCode, ur.headers); res.end(t);
        });
        return;
      }
      res.writeHead(ur.statusCode || 502, ur.headers);
      ur.pipe(res);
    });
    up.on('error', (err) => { log('upstream error', err.code); res.writeHead(502); res.end(JSON.stringify({ error: { message: `shim: ${err.code}` } })); });
    up.end(body);
  });
}).listen(PORT, '127.0.0.1', () => log(`learnai-shim on 127.0.0.1:${PORT} → ${UPSTREAM.origin}`));
