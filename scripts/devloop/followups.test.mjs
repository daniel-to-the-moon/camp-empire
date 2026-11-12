// 遗留意见 issue 的幂等创建与本机待办清单（followups.mjs）
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ACTIVE_RUN_STATUSES, branchExists, completeFollowUps, dispatchState, doneComment, drainPending, ensureFollowUps,
  findByKey, FOLLOWUP_LABEL, FOLLOWUP_MARK, followUpItems, hasActiveRun, listRecoverable, parseRecord, recordComment,
  recoverFollowUps, REDISPATCH_AFTER_MS, shouldDispatch, writeJsonAtomic,
} from './followups.mjs';

const H = 'a'.repeat(40);
const root = mkdtempSync(join(tmpdir(), 'followups-'));
after(() => rmSync(root, { recursive: true, force: true }));
const fd = (issue) => ({ severity: 'major', file: 'a.ts', line: 1, issue, suggestion: 's' });
const items = followUpItems({ pr: 7, head: H, findings: [fd('一'), fd('二')] });

/**
 * 假 GitHub：issues 存在内存里。plan：每次 create 调用的结果
 * 'ok' 正常创建；'lost' 服务端已创建但客户端报错（响应丢失）；'fail' 未创建且报错。listFail：前几次 list 抛错。
 */
function fakeGh({ plan = [], listFail = 0, existing = [] } = {}) {
  const issues = [...existing];
  const log = [];
  let c = 0;
  let l = 0;
  return {
    issues,
    log,
    list: () => {
      log.push('list');
      if (l++ < listFail) throw new Error('list 503');
      return issues.map((x) => ({ ...x }));
    },
    create: (it) => {
      const mode = plan[c++] ?? 'ok';
      log.push(`create:${mode}`);
      if (mode === 'fail') throw new Error('create 502');
      const number = 100 + issues.length;
      issues.push({ number, body: it.body });
      if (mode === 'lost') throw new Error('socket hang up');
      return `https://github.com/o/r/issues/${number}\n`;
    },
    sleep: async () => {},
  };
}

test('followUpItems：每条意见有稳定 key，正文末尾带标记；findByKey 只认完整标记', () => {
  assert.deepEqual(items.map((x) => x.key), [`pr7-${H.slice(0, 12)}-1`, `pr7-${H.slice(0, 12)}-2`]);
  assert.ok(items[0].body.endsWith(`${FOLLOWUP_MARK}${items[0].key} -->`));
  assert.equal(findByKey([{ number: 5, body: items[0].body }], items[0].key), 5);
  assert.equal(findByKey([{ number: 5, body: `${FOLLOWUP_MARK}${items[0].key}0 -->` }], items[0].key), null);
});

test('ensureFollowUps：服务端已创建但客户端报错 → 重试前重新核对，复用已创建的 issue，只产生一个', async () => {
  const g = fakeGh({ plan: ['lost', 'ok'] });
  const r = await ensureFollowUps(items, g);
  assert.equal(g.issues.length, 2);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(Object.values(r.numbers), [100, 101]);
  assert.deepEqual(r.created, [101]); // 第一条是在核对中找回的，不算本次新建
});

test('ensureFollowUps：已存在同 key 的 issue → 不再创建；查询失败时不盲目创建', async () => {
  const g = fakeGh({ existing: [{ number: 9, body: items[0].body }] });
  const r = await ensureFollowUps(items, g);
  assert.equal(r.numbers[items[0].key], 9);
  assert.equal(g.issues.length, 2);
  const down = fakeGh({ listFail: 99 });
  const d = await ensureFollowUps(items, down);
  assert.equal(down.issues.length, 0);
  assert.equal(d.failed.length, 2);
  assert.ok(!down.log.some((x) => x.startsWith('create')));
});

test('ensureFollowUps：部分失败 → 报告失败项，其余照常开', async () => {
  const g = fakeGh({ plan: ['ok', 'fail', 'fail', 'fail'] });
  const r = await ensureFollowUps(items, g, { attempts: 3 });
  assert.equal(g.issues.length, 1);
  assert.deepEqual(r.failed.map((f) => f.key), [items[1].key]);
});

test('drainPending：合并后评论失败也不丢；部分失败保留清单并加 needs-user（只加一次），下一轮补齐后发清单、删文件', async () => {
  const dir = join(root, 'pending');
  mkdirSync(dir);
  writeFileSync(join(dir, 'pr-7.json'), JSON.stringify({ pr: 7, items }));
  const flags = [];
  const comments = [];
  const g = fakeGh({ plan: ['ok', 'fail', 'fail', 'fail'] });
  const io = { ...g, flag: (pr) => flags.push(pr), comment: (pr, t) => comments.push([pr, t]), log: () => {} };
  await drainPending({ dir, io });
  assert.ok(existsSync(join(dir, 'pr-7.json')));
  assert.deepEqual(flags, [7]);
  assert.equal(comments.length, 0);
  await drainPending({ dir, io }); // 第二轮：仍失败（plan 里剩下的 fail 用完前），不重复加标签
  assert.deepEqual(flags, [7]);
  await drainPending({ dir, io }); // 之后 create 默认成功
  assert.ok(!existsSync(join(dir, 'pr-7.json')));
  assert.equal(g.issues.length, 2); // 两条意见各一个 issue，无重复
  assert.match(comments.at(-1)[1], /#100、#101/);
});

test('drainPending：清单评论失败不影响删除（issue 已开齐）；目录不存在时无操作', async () => {
  const dir = join(root, 'pending2');
  mkdirSync(dir);
  writeFileSync(join(dir, 'pr-8.json'), JSON.stringify({ pr: 8, items }));
  const g = fakeGh();
  await drainPending({ dir, io: { ...g, flag: () => {}, comment: () => { throw new Error('comment 500'); }, log: () => {} } });
  assert.ok(!existsSync(join(dir, 'pr-8.json')));
  await drainPending({ dir: join(root, 'nope'), io: {} });
  assert.equal(readFileSync.length > 0, true);
});

/** 进程间互斥锁的假实现：被占用时返回 null（与 gitops.acquireLock 相同约定） */
function fakeLock() {
  let held = false;
  return async () => {
    await null;
    if (held) return null;
    held = true;
    return async () => { held = false; };
  };
}

/** 异步 io：每次 list / create 之间让出事件循环，模拟两个处理者交错 */
function asyncGh() {
  const g = fakeGh();
  return { ...g, list: async () => { await null; return g.list(); }, create: async (it) => { await null; return g.create(it); } };
}

test('drainPending：两个处理者交错执行——不加锁会重复创建；共用同一把锁时每个 key 只创建一次', async () => {
  const mk = (name) => {
    const dir = join(root, name);
    mkdirSync(dir);
    writeFileSync(join(dir, 'pr-7.json'), JSON.stringify({ pr: 7, items }));
    return dir;
  };
  const quiet = { flag: () => {}, comment: () => {}, log: () => {} };
  // 对照：不加锁，两个处理者都先查到“不存在”，各自创建
  const d1 = mk('race-nolock');
  const g1 = asyncGh();
  await Promise.all([drainPending({ dir: d1, io: { ...g1, ...quiet } }), drainPending({ dir: d1, io: { ...g1, ...quiet } })]);
  assert.ok(g1.issues.length > items.length, '对照组应出现重复，说明测试确实制造了交错');
  // 共用锁：后到者拿不到锁就跳过，不会重复
  const d2 = mk('race-lock');
  const g2 = asyncGh();
  const acquire = fakeLock();
  await Promise.all([drainPending({ dir: d2, io: { ...g2, ...quiet }, acquire }), drainPending({ dir: d2, io: { ...g2, ...quiet }, acquire })]);
  assert.equal(g2.issues.length, items.length);
  assert.ok(!existsSync(join(d2, 'pr-7.json')));
});

const quiet = { flag: () => {}, comment: () => {}, log: () => {} };

test('持久化与查询：合并前待办在补开前核对状态；打开、查询失败、未按该 head 合并都不创建 issue', async () => {
  const run = async (status) => {
    const dir = mkdtempSync(join(root, 'st-'));
    writeFileSync(join(dir, 'pr-7.json'), JSON.stringify({ pr: 7, head: H, items }));
    const g = fakeGh();
    await drainPending({ dir, io: { ...g, ...quiet, prStatus: async () => status } });
    return { kept: existsSync(join(dir, 'pr-7.json')), created: g.issues.length };
  };
  assert.deepEqual(await run({ state: 'OPEN', headRefOid: H }), { kept: true, created: 0 });
  assert.deepEqual(await run({ state: 'CLOSED', headRefOid: H }), { kept: false, created: 0 });
  assert.deepEqual(await run({ state: 'MERGED', headRefOid: 'c'.repeat(40) }), { kept: false, created: 0 });
  assert.deepEqual(await run({ state: 'MERGED', headRefOid: H }), { kept: false, created: 2 });
  const dir = mkdtempSync(join(root, 'st-'));
  writeFileSync(join(dir, 'pr-7.json'), JSON.stringify({ pr: 7, head: H, items }));
  const g = fakeGh();
  await drainPending({ dir, io: { ...g, ...quiet, prStatus: async () => { throw new Error('502'); } } });
  assert.ok(existsSync(join(dir, 'pr-7.json')));
  assert.equal(g.issues.length, 0);
});

test('持久化中断：flagged 写入失败时原文件不变，下一轮仍能恢复；损坏文件不阻断其他待办', async () => {
  const dir = mkdtempSync(join(root, 'atomic-'));
  writeFileSync(join(dir, 'pr-7.json'), JSON.stringify({ pr: 7, head: H, items }));
  writeFileSync(join(dir, 'pr-8.json'), '{"pr": 8, "items": [');
  const g = fakeGh({ plan: ['fail', 'fail', 'fail'] });
  const logs = [];
  const writeJson = (file, data) => writeJsonAtomic(file, data, {
    write: (f, t) => { writeFileSync(f, t.slice(0, 5)); throw new Error('ENOSPC'); },
  });
  await drainPending({ dir, io: { ...g, flag: () => {}, comment: () => {}, log: (m) => logs.push(m), writeJson } });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'pr-7.json'), 'utf8')).pr, 7);
  assert.equal(JSON.parse(readFileSync(join(dir, 'pr-7.json'), 'utf8')).flagged, undefined);
  assert.ok(logs.some((m) => m.includes('pr-8.json')));
  await drainPending({ dir, io: { ...fakeGh(), flag: () => {}, comment: () => {}, log: () => {} } });
  assert.ok(!existsSync(join(dir, 'pr-7.json')));
});

/** 内存里的 issue 与触发记录。create/dispatch 只改这些数组，不启动子进程，不访问网络。 */
function followWorld({ now = 1e12, createPlan = [], dispatchPlan = [], activeRun = false, branchThrows = null } = {}) {
  const w = { issues: [], dispatched: [], done: [], branches: new Set(), now, activeRun, calls: [] };
  let c = 0;
  let dc = 0;
  w.io = {
    list: () => w.issues.map((x) => ({ number: x.number, body: x.body })),
    create: (it) => {
      w.calls.push('create');
      const mode = createPlan[c++] ?? 'ok';
      if (mode === 'crash') throw new Error('runner cancelled');
      w.issues.push({ number: 90 + w.issues.length, body: it.body, comments: [] });
      if (mode === 'lost') throw new Error('socket hang up');
      return `https://example.invalid/issues/${w.issues.at(-1).number}\n`;
    },
    issueInfo: (n) => {
      if (branchThrows) {
        branchExists(() => { throw branchThrows; }, 'o/r', `claude/issue-${n}`);
      }
      const x = w.issues.find((i) => i.number === n);
      return {
        state: 'OPEN',
        labels: ['devloop'],
        branch: w.branches.has(n),
        activeRun: w.activeRun,
        comments: x.comments,
      };
    },
    markDispatch: (n) => {
      w.calls.push(`mark #${n}`);
      w.issues.find((i) => i.number === n).comments.push({
        body: '<!-- devloop-dispatch pr=7 -->',
        createdAt: new Date(w.now).toISOString(),
      });
    },
    dispatch: (n) => {
      w.calls.push(`dispatch #${n}`);
      if ((dispatchPlan[dc++] ?? 'ok') === 'fail') throw new Error('dispatch 502');
      w.dispatched.push(n);
    },
    done: (numbers) => { w.calls.push('done'); w.done.push(numbers); },
    now: () => w.now,
    sleep: async () => {},
  };
  return w;
}

const one = () => followUpItems({ pr: 7, head: H, findings: [fd('一')] });

test('查询失败：分支查询 5xx 向上抛，本轮不记触发标记、不触发、不标完成', async () => {
  const err = Object.assign(new Error('Command failed'), { stderr: 'gh: Server Error (HTTP 502)' });
  assert.throws(() => branchExists(() => { throw err; }, 'o/r', 'claude/issue-9'), /查询分支/);
  assert.equal(branchExists(() => { throw Object.assign(new Error('x'), { stderr: 'HTTP 404' }); }, 'o/r', 'b'), false);
  assert.equal(branchExists(() => '{}', 'o/r', 'b'), true);
  for (const e of [err, Object.assign(new Error('x'), { stderr: 'API rate limit exceeded (HTTP 403)' }), new Error('spawnSync gh ETIMEDOUT')]) {
    assert.throws(() => branchExists(() => { throw e; }, 'o/r', 'b'), /查询分支/);
  }
  const w = followWorld({ branchThrows: err });
  const r = await completeFollowUps(one(), w.io, { attempts: 1, delayMs: 0 });
  assert.equal(r.failed.length, 1);
  assert.deepEqual(r.pending, []);
  assert.deepEqual(w.dispatched, []);
  assert.equal(w.done.length, 0);
  assert.ok(!w.calls.some((x) => x.startsWith('mark') || x.startsWith('dispatch') || x === 'done'));
});

test('重复触发与冷却：2 小时内不重复触发；活动任务超过 2 小时也不补触发', async () => {
  const w = followWorld({ dispatchPlan: ['fail'] });
  const items = one();
  const a = await completeFollowUps(items, w.io, { attempts: 1, delayMs: 0 });
  assert.equal(a.failed.length, 1);
  assert.equal(w.done.length, 0);
  w.now += 10 * 60_000;
  const b = await completeFollowUps(items, w.io, { attempts: 1, delayMs: 0 });
  assert.deepEqual(b.pending, [90]);
  assert.deepEqual(w.dispatched, []);
  assert.equal(w.done.length, 0);
  w.activeRun = true;
  w.now += REDISPATCH_AFTER_MS;
  const c = await completeFollowUps(items, w.io, { attempts: 1, delayMs: 0 });
  assert.deepEqual(c.pending, [90]);
  assert.deepEqual(w.dispatched, []);
  assert.equal(dispatchState({
    state: 'OPEN', labels: ['devloop'], branch: false, activeRun: true,
    comments: [{ body: '<!-- devloop-dispatch pr=7 -->', createdAt: new Date(w.now - REDISPATCH_AFTER_MS * 3).toISOString() }],
  }, w.now), 'cooldown');
  assert.equal(shouldDispatch({ state: 'OPEN', labels: ['devloop'], branch: true, comments: [], activeRun: false }, w.now), false);
});

test('派发成功但实现未产出（分支查询失败而跳过的那种结果）时不标完成；冷却期内不重复派发', async () => {
  const w = followWorld();
  const items = one();
  const a = await completeFollowUps(items, w.io, { attempts: 1, delayMs: 0 });
  assert.deepEqual(a.pending, [90]);
  assert.deepEqual(w.dispatched, [90]);
  assert.equal(w.done.length, 0);
  w.now += 30 * 60_000;
  const b = await completeFollowUps(items, w.io, { attempts: 1, delayMs: 0 });
  assert.deepEqual(b.pending, [90]);
  assert.deepEqual(w.dispatched, [90]);
  assert.equal(w.done.length, 0);
  w.now += REDISPATCH_AFTER_MS;
  const c = await completeFollowUps(items, w.io, { attempts: 1, delayMs: 0 });
  assert.deepEqual(w.dispatched, [90, 90]);
  assert.deepEqual(c.pending, [90]);
  assert.equal(w.done.length, 0);
  w.branches.add(90);
  const d = await completeFollowUps(items, w.io, { attempts: 1, delayMs: 0 });
  assert.deepEqual(d.pending, []);
  assert.deepEqual(w.dispatched, [90, 90]);
  assert.equal(w.done.length, 1);
});

test('恢复重放：部分创建中断后不重复开、不在冷却期内重复触发；完成标记与不可信记录会跳过', async () => {
  const items = followUpItems({ pr: 7, head: H, findings: [fd('一'), fd('二')] });
  const rec = { author: 'github-actions', body: recordComment({ pr: 7, head: H, items }) };
  const w = followWorld({ createPlan: ['ok', 'crash'] });
  const first = await recoverFollowUps([{ number: 7, headRefOid: H, comments: [rec] }], () => w.io, { attempts: 1, delayMs: 0 });
  assert.equal(first[0].failed.length, 1);
  assert.deepEqual(w.dispatched, [90]);
  assert.equal(w.done.length, 0);
  const second = await recoverFollowUps([{ number: 7, headRefOid: H, comments: [rec] }], () => w.io, { attempts: 1, delayMs: 0 });
  assert.deepEqual(second[0].failed, []);
  assert.deepEqual(second[0].pending, [90, 91]);
  assert.equal(w.issues.length, 2);
  assert.deepEqual(w.dispatched, [90, 91]);
  assert.equal(w.done.length, 0);
  w.branches.add(90);
  w.branches.add(91);
  await recoverFollowUps([{ number: 7, headRefOid: H, comments: [rec] }], () => w.io, { attempts: 1, delayMs: 0 });
  assert.deepEqual(w.dispatched, [90, 91]);
  assert.equal(w.done.length, 1);
  const doneC = { author: 'github-actions[bot]', body: doneComment({ pr: 7, head: H, numbers: [90, 91] }) };
  assert.equal((await recoverFollowUps([{ number: 7, headRefOid: H, comments: [rec, doneC] }], () => w.io)).length, 0);
  assert.equal((await recoverFollowUps([{ number: 7, headRefOid: H, comments: [{ ...rec, author: 'someone' }] }], () => w.io)).length, 0);
  assert.equal((await recoverFollowUps([{ number: 7, headRefOid: 'c'.repeat(40), comments: [rec] }], () => w.io)).length, 0);
  assert.equal(parseRecord([{ body: recordComment({ pr: 7, head: H, items }).replace(/b64=[A-Za-z0-9+/=]+/, 'b64=%%%') }], { pr: 7, head: H }).items, null);
});

test('只读索引：登记落在第 121 条评论仍能解析；列表请求不含 comments 字段；活动运行按状态过滤', () => {
  const found = followUpItems({ pr: 3, head: H, findings: [fd('一')] });
  const comments = Array.from({ length: 150 }, (_, k) => ({ author: 'someone', body: `c${k}` }));
  comments[120] = { author: 'github-actions', body: recordComment({ pr: 3, head: H, items: found }) };
  const seen = [];
  const ghR = (args) => { seen.push(args); return JSON.stringify([{ number: 3, headRefOid: H }]); };
  const gh = (args) => {
    assert.equal(args[1], '--paginate');
    assert.match(args[2], /^repos\/o\/r\/issues\/3\/comments/);
    return `${comments.map((c) => JSON.stringify(c)).join('\n')}\n`;
  };
  const prs = listRecoverable(ghR, gh, 'o/r');
  assert.equal(prs[0].comments.length, 150);
  const a = seen[0];
  assert.equal(a[a.indexOf('--label') + 1], FOLLOWUP_LABEL);
  assert.ok(Number(a[a.indexOf('--limit') + 1]) >= 1000);
  assert.ok(!a[a.indexOf('--json') + 1].includes('comments'));
  assert.deepEqual(parseRecord(prs[0].comments.filter((c) => c.author === 'github-actions'), { pr: 3, head: H }).items, found);
  const runs = [];
  const listed = hasActiveRun((args) => {
    const st = args[args.indexOf('--status') + 1];
    runs.push(st);
    assert.ok(Number(args[args.indexOf('--limit') + 1]) >= 1000);
    const others = Array.from({ length: 80 }, (_, k) => ({ displayTitle: `other#${k}` }));
    return JSON.stringify(st === 'pending' ? [...others, { displayTitle: 'claude issue#9' }] : []);
  }, 9);
  assert.equal(listed, true);
  assert.deepEqual(runs, ACTIVE_RUN_STATUSES);
  assert.equal(hasActiveRun(() => '[]', 9), false);
});

test('生产入口未接线：状态机不被 cloud、devloop 或工作流调用；库内不含创建或派发命令', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const read = (name) => readFileSync(join(dir, name), 'utf8');
  const cloud = read('cloud.mjs');
  const devloop = read('devloop.mjs');
  const lib = read('followups.mjs');
  const gpt = readFileSync(join(dir, '../../.github/workflows/gpt-review.yml'), 'utf8');
  const claude = readFileSync(join(dir, '../../.github/workflows/claude.yml'), 'utf8');
  const ctx = read('ctx.sh');
  assert.match(cloud, /import \{ ensureFollowUps, followUpItems \} from '\.\/followups\.mjs'/);
  assert.doesNotMatch(cloud, /completeFollowUps|recoverFollowUps|cloudFollowIo|listRecoverable|branchExists|hasActiveRun|devloop-followups|cmd === 'recover'/);
  assert.match(cloud, /ensureFollowUps\(issues/);
  assert.doesNotMatch(devloop, /completeFollowUps|recoverFollowUps|devloop-dispatch|devloop-followups|workflow run/);
  assert.match(devloop, /import \{ drainPending, followUpItems \} from '\.\/followups\.mjs'/);
  const merge = devloop.slice(devloop.indexOf('if (followItems.length) savePending('), devloop.indexOf("d.reason = 'merge'"));
  assert.ok(merge.includes('savePending(pr, head, followItems)'));
  assert.ok(merge.indexOf('savePending(pr, head, followItems)') < merge.indexOf('mergeAndPush('));
  assert.doesNotMatch(merge, /rmSync\(/);
  assert.match(devloop, /prStatus: \(pr\) => JSON\.parse\(gh\(\['pr', 'view'/);
  assert.equal(devloop.split("gh(['issue', 'create'").length - 1, 1);
  // 文件头那句“issue create 不是幂等的”是 main 上原有的说明。新增的恢复状态段不包含创建或派发命令，也不起子进程。
  assert.equal(lib.split('issue create').length - 1, 1);
  assert.match(lib, /issue create 不是幂等的/);
  const added = lib.slice(lib.indexOf('恢复状态（库函数'));
  assert.doesNotMatch(added, /issue create|workflow run|child_process|execFile|spawnSync|spawn\(/);
  assert.doesNotMatch(lib, /from 'node:child_process'|execFileSync|spawnSync/);
  assert.doesNotMatch(gpt, /\n {2}recover:/);
  assert.doesNotMatch(gpt, /cloud\.mjs recover/);
  assert.doesNotMatch(claude, /mode != 'skip'/);
  assert.doesNotMatch(claude, /claude issue#/);
  assert.doesNotMatch(ctx, /mode=skip/);
});
