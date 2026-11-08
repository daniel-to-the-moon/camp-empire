// ci.yml pages 任务的行为测试：假 Cloudflare API（本地 HTTP 服务）+ 假 gh / wrangler；并读取真实 YAML 检查任务门控
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'devloop-pages-'));
const ACCOUNT = 'acc123';

/** 假 Cloudflare API：projects 为已存在的项目；createFails 时创建返回错误；记录请求 */
let state;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    state.calls.push(`${req.method} ${req.url}`);
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (!req.url.startsWith('/accounts/')) {
      // 假的 pages.dev 站点：按 Host 判断是否被 Access 保护
      const host = (req.headers.host || '').split(':')[0];
      const mode = state.access[host] ?? state.access['*'] ?? 'open';
      if (mode === 'redirect') { res.writeHead(302, { location: `https://team.cloudflareaccess.com/cdn-cgi/access/login/${host}?kid=k&redirect_url=%2F` }); return res.end(); }
      if (mode === 'forbidden') { res.writeHead(403); return res.end('Browser Integrity Check'); }
      if (mode === 'unauthorized') { res.writeHead(401); return res.end(); }
      if (mode.startsWith('to:')) { res.writeHead(302, { location: mode.slice(3) }); return res.end(); }
      res.writeHead(200); return res.end('<html>');
    }
    const m = req.url.match(/^\/accounts\/([^/]+)\/pages\/projects(?:\/([^/]+))?$/);
    if (!m || m[1] !== ACCOUNT || req.headers.authorization !== 'Bearer tok') return send(403, { success: false, errors: [{ message: 'forbidden' }] });
    if (req.method === 'GET' && m[2]) {
      const p = state.projects.find((x) => x === m[2]); // 精确按名字
      return p ? send(200, { success: true, result: { name: p, subdomain: `${p}.pages.dev` } }) : send(404, { success: false, errors: [{ message: 'not found' }] });
    }
    if (req.method === 'POST' && !m[2]) {
      if (state.createFails) return send(400, { success: false, errors: [{ message: 'name taken' }] });
      const { name } = JSON.parse(body);
      state.projects.push(name);
      return send(200, { success: true, result: { name, subdomain: `${name}-x1.pages.dev` } });
    }
    send(405, { success: false });
  });
});
let base;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
function setup({ projects = [], createFails = false, latest = 'sha1', dist = true, access = { '*': 'redirect' } } = {}) {
  state = { projects: [...projects], createFails, calls: [], access };
  const dir = join(root, `c${n++}`);
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash\necho "$*" >> "${dir}/gh.log"\nprintf '%s' "${latest}"\n`);
  writeFileSync(join(bin, 'wrangler'), `#!/usr/bin/env bash\necho "$*" >> "${dir}/wrangler.log"\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  chmodSync(join(bin, 'wrangler'), 0o755);
  const distDir = join(dir, 'dist');
  mkdirSync(distDir);
  if (dist) writeFileSync(join(distDir, 'index.html'), '<html>');
  const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
  const run = (env = {}) =>
    new Promise((resolve) => {
      const p = spawn('bash', [join(HERE, 'pages.sh')], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          CLOUDFLARE_API_TOKEN: 'tok',
          CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
          PROJECT: 'camp-empire',
          SHA: 'sha1',
          DIST: distDir,
          REPO: 'o/r',
          WRANGLER: join(bin, 'wrangler'),
          CF_API: base,
          ACCESS_CHECK_SCHEME: 'http',
          ACCESS_CHECK_CONNECT: base.replace('http://', ''),
          SUMMARY: join(dir, 'summary.md'),
          ...env,
        },
      });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('exit', (code) => resolve({ code, out, err }));
    });
  return { run, wrangler: () => read('wrangler.log'), summary: () => read('summary.md') };
}

test('缺凭据：明确失败', async () => {
  const t = setup({ projects: ['camp-empire'] });
  for (const k of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
    const r = await t.run({ [k]: '' });
    assert.notEqual(r.code, 0);
    assert.match(r.err, new RegExp(k));
  }
});

test('项目已存在：精确取到地址，不创建；开关关闭时不上传', async () => {
  const t = setup({ projects: ['camp-empire'] });
  const r = await t.run({ DEPLOY: '' });
  assert.equal(r.code, 0, r.err);
  assert.match(t.summary(), /https:\/\/camp-empire\.pages\.dev/);
  assert.ok(!state.calls.some((c) => c.startsWith('POST')));
  assert.equal(t.wrangler(), '');
});

test('项目不存在：创建后用 Cloudflare 返回的实际地址（可能带后缀）', async () => {
  const t = setup();
  const r = await t.run({ DEPLOY: '' });
  assert.equal(r.code, 0, r.err);
  assert.match(t.summary(), /https:\/\/camp-empire-x1\.pages\.dev/);
});

test('只有同前缀的其他项目、目标创建失败：失败并保留错误，不误用别的项目地址', async () => {
  const t = setup({ projects: ['camp-empire-staging'], createFails: true });
  const r = await t.run({ DEPLOY: 'true' });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /name taken/);
  assert.doesNotMatch(t.summary(), /camp-empire-staging/);
  assert.equal(t.wrangler(), '');
});

test('开关开启且是 main 最新提交：上传正确的产物目录与提交号', async () => {
  const t = setup({ projects: ['camp-empire'], latest: 'sha1' });
  const r = await t.run({ DEPLOY: 'true' });
  assert.equal(r.code, 0, r.err);
  assert.match(t.wrangler(), /^pages deploy \S+\/dist --project-name camp-empire --branch main --commit-hash sha1 /m);
});

test('Access 兜底：只有重定向到 https://<团队>.cloudflareaccess.com/cdn-cgi/access/login 才算受保护', async () => {
  const refuse = [
    { '*': 'open' },
    { '*': 'forbidden' }, // 反机器人 403：不能证明有 Access
    { '*': 'unauthorized' },
    { '*': 'to:https://example.com/' },
    { '*': 'to:https://evil.com/?next=team.cloudflareaccess.com/cdn-cgi/access/login' },
    { '*': 'to:http://team.cloudflareaccess.com/cdn-cgi/access/login' }, // 非 https
    { '*': 'to:https://team.cloudflareaccess.com.evil.com/cdn-cgi/access/login' }, // 主机后缀伪装
    { '*': 'to:https://cloudflareaccess.com/cdn-cgi/access/login' }, // 缺团队子域
    { '*': 'to:https://team.cloudflareaccess.com/other' }, // 路径不对
    { '*': 'to:https://team.cloudflareaccess.com/cdn-cgi/access/loginx' },
    { 'camp-empire.pages.dev': 'redirect', '*': 'open' }, // 只保护了正式地址
    { 'camp-empire.pages.dev': 'open', '*': 'redirect' }, // 只保护了预览地址
  ];
  for (const access of refuse) {
    const t = setup({ projects: ['camp-empire'], access });
    const r = await t.run({ DEPLOY: 'true' });
    assert.notEqual(r.code, 0, JSON.stringify(access));
    assert.match(r.err, /未确认受 Cloudflare Access 保护/);
    assert.equal(t.wrangler(), '', JSON.stringify(access));
  }
  const ok = setup({ projects: ['camp-empire'], access: { '*': 'redirect' } });
  assert.equal((await ok.run({ DEPLOY: 'true' })).code, 0);
  assert.notEqual(ok.wrangler(), '');
});

test('过期运行（main 已有更新的提交，含历史重跑与逆序完成）：跳过上传', async () => {
  const t = setup({ projects: ['camp-empire'], latest: 'sha2' });
  const r = await t.run({ DEPLOY: 'true', SHA: 'sha1' });
  assert.equal(r.code, 0, r.err);
  assert.equal(t.wrangler(), '');
  assert.match(t.summary(), /已不是 main 最新/);
});

test('产物不完整：失败，不上传', async () => {
  const t = setup({ projects: ['camp-empire'], dist: false });
  const r = await t.run({ DEPLOY: 'true' });
  assert.notEqual(r.code, 0);
  assert.equal(t.wrangler(), '');
});

test('项目名非法（防注入）：失败', async () => {
  const t = setup({ projects: ['camp-empire'] });
  for (const PROJECT of ['', 'Camp', 'a b', 'x;rm -rf /', '../x']) assert.notEqual((await t.run({ PROJECT })).code, 0, PROJECT);
});

test('ci.yml：pages 任务只在 main 上（push 或 deploy_main 触发）运行、串行且保留全部排队（queue: max），并调用 pages.sh', () => {
  const yml = readFileSync(join(HERE, '../../.github/workflows/ci.yml'), 'utf8');
  const job = yml.match(/^  pages:\n((?:(?: {4,}.*)?\n)*)/m);
  assert.ok(job, 'ci.yml 里找不到 pages 任务');
  const body = job[1];
  assert.match(body, /^ {4}if: github\.ref == 'refs\/heads\/main' && \(github\.event_name == 'push' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.deploy_main == 'true'\)\)$/m);
  assert.match(body, /^ {4}concurrency:\n {6}group: pages-deploy\n {6}cancel-in-progress: false\n {6}queue: max$/m);
  assert.match(body, /bash _devloop\/scripts\/devloop\/pages\.sh/);
  assert.match(body, /DEPLOY: \$\{\{ vars\.PAGES_DEPLOY \}\}/);
});
