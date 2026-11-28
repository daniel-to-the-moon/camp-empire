/**
 * 角色技能卡第一轮（issue #112，纸样 docs/SKILL_CARDS.md v0.8）：规则对照组选事唯一、核对器拦下第八节反例、收据分两层。
 * 模型输出全部是固定假数据，不接真实模型。
 */
import { describe, expect, it } from 'vitest';
import {
  ABOUT_MAX_CHARS,
  applySafety,
  safetyTexts,
  buildReceipt,
  allowedKinds,
  auditRecord,
  AUDIT_RETENTION_DAYS,
  deliverable,
  type Grants,
  checkOutput,
  selectRuleEvent,
  snapshotFacts,
  STARTER_CARDS,
  plainReceipt,
  validateSnapshot,
  mergeRuleResponse,
  claimVisit,
  type RuleEvent,
  type CardId,
  type EncounterSnapshot,
  type FactRef,
  type Gear,
  type ModelOutput,
} from '../src/shared/skillcards';

/** 第七节的世界状态：下雨的清晨；乙营主、本人在场，带 sunrise、侧帐已展开；甲来访、托管中，带炉具和侧帐。 */
function world(aCards: CardId[], aGear: Gear[] = ['stove', 'awning'], over: Partial<EncounterSnapshot> = {}): EncounterSnapshot {
  return {
    visitId: 'v1',
    time: 'dawn',
    weather: 'rain',
    a: { cards: aCards, gear: aGear, awningDeployed: false, presence: 'hosted', role: 'guest' },
    b: { cards: ['sunrise'], gear: ['awning'], awningDeployed: true, presence: 'present', role: 'host' },
    ...over,
  };
}

const F = {
  dawn: { subject: 'camp', key: 'time:dawn' },
  rain: { subject: 'camp', key: 'weather:rain' },
  aStove: { subject: 'a', key: 'gear:stove' },
  aAwning: { subject: 'a', key: 'gear:awning' },
  bAwning: { subject: 'b', key: 'gear:awning' },
  bDeployed: { subject: 'b', key: 'awning:deployed' },
} satisfies Record<string, FactRef>;

/** 规则对照组的模型响应：只写讲述，不带编号、步骤、动作和 activity。 */
function ruleResp(): ModelOutput {
  return { kind: [], happening: '', because: [], facts_used: [F.dawn, F.rain, F.aStove], view_a: trip1().view_a, view_b: trip1().view_b };
}

/** 第七节第一趟生长组的假输出。 */
function trip1(): ModelOutput {
  return {
    kind: ['activity'],
    happening: '乙天没亮就来敲车门，说坡上能看日出，等雨停就出发；甲用炉具煮了两杯咖啡带上去。',
    because: [
      { type: 'activity', card: 'sunrise', side: 'b', step: '先邀甲去坡上', uses: [F.dawn] },
      { type: 'activity', card: 'coffee', side: 'a', step: '煮了两杯', uses: [F.aStove] },
    ],
    actions: [
      { side: 'b', action: '先邀甲去坡上' },
      { side: 'a', action: '煮了两杯' },
    ],
    facts_used: [F.dawn, F.rain, F.aStove],
    view_a: '乙一早叫我去坡上等日出，我煮了两杯咖啡带上去。',
    view_b: '一早我去叫甲，甲煮了两杯咖啡，我们撑伞在坡上等。',
  };
}

describe('卡数据', () => {
  it('六张起始卡：about 不超过上限，origin 都是起始，needs 与纸样一致', () => {
    expect(Object.keys(STARTER_CARDS).sort()).toEqual(['carfan', 'coffee', 'fixer', 'rain', 'stars', 'sunrise']);
    for (const c of Object.values(STARTER_CARDS)) {
      expect([...c.about].length).toBeLessThanOrEqual(ABOUT_MAX_CHARS);
      expect(c.origin).toEqual({ kind: 'starter' });
    }
    expect(STARTER_CARDS.coffee.needs).toEqual(['stove']);
    expect(STARTER_CARDS.rain.needs).toEqual(['awning']);
  });

  it('快照自洽检查：超过 3 张、重复卡、主客相同都报错', () => {
    expect(validateSnapshot(world(['coffee', 'fixer']))).toEqual([]);
    expect(validateSnapshot(world(['coffee', 'fixer', 'rain', 'stars']))).toHaveLength(1);
    expect(validateSnapshot(world(['coffee', 'coffee']))).toHaveLength(1);
    const s = world(['coffee']);
    s.b.role = 'guest';
    expect(validateSnapshot(s)).toHaveLength(1);
  });

  it('事实快照：侧帐没带就不算已展开', () => {
    const s = world(['coffee'], ['stove']);
    s.a.awningDeployed = true;
    expect(snapshotFacts(s)).not.toContainEqual({ subject: 'a', key: 'awning:deployed' });
    expect(snapshotFacts(s)).toContainEqual(F.bDeployed);
  });
});

describe('规则对照组选事（第十节，同一快照结果唯一）', () => {
  it('第一趟 coffee+fixer：双卡优先，选 A1 日出咖啡', () => {
    const e = selectRuleEvent(world(['coffee', 'fixer']));
    expect(e.action).toBe('A1');
    expect(e.because.map((b) => `${b.card}/${b.side}`)).toEqual(['coffee/a', 'sunrise/b']);
  });

  it('第二趟换成 rain：rain 与 fixer 同在甲方不算双卡，按编号选单卡 A3', () => {
    expect(selectRuleEvent(world(['rain', 'fixer'])).action).toBe('A3');
  });

  it('talk 示例甲只带 carfan：唯一结果 A4', () => {
    expect(selectRuleEvent(world(['carfan'])).action).toBe('A4');
  });

  it('甲带 coffee、fixer 但没带炉具：A1 在选事阶段剔除，结果 A4', () => {
    expect(selectRuleEvent(world(['coffee', 'fixer'], ['awning'])).action).toBe('A4');
  });

  it('甲带 rain、乙带 fixer，只切换甲车侧帐：有 → A7，无 → A7 与 A3 都剔除 → A4', () => {
    const withAwning = world(['rain']);
    withAwning.b.cards = ['fixer'];
    expect(selectRuleEvent(withAwning).action).toBe('A7');
    const without = world(['rain'], ['stove']);
    without.b.cards = ['fixer'];
    const e = selectRuleEvent(without);
    expect(e.action).toBe('A4');
    expect(e.because).toMatchObject([{ type: 'activity', card: 'fixer', side: 'b' }]);
  });

  it('双方都能触发 A1：营主一方固定持 coffee，归因唯一', () => {
    const s = world(['coffee', 'sunrise']);
    s.b = { ...s.b, cards: ['coffee', 'sunrise'], gear: ['stove', 'awning'] };
    const e = selectRuleEvent(s);
    expect(e.action).toBe('A1');
    expect(e.because.map((b) => `${b.card}/${b.side}`)).toEqual(['coffee/b', 'sunrise/a']);
    expect(e.because[0].uses).toContainEqual({ subject: 'b', key: 'gear:stove' });
    const flipped = { ...s, a: { ...s.a, role: 'host' as const }, b: { ...s.b, role: 'guest' as const } };
    expect(selectRuleEvent(flipped).because.map((b) => `${b.card}/${b.side}`)).toEqual(['coffee/a', 'sunrise/b']);
  });

  it('同卡配对不触发双卡动作；都不成立就“无事”', () => {
    const s = world(['sunrise'], [], { weather: 'clear' });
    expect(selectRuleEvent(s)).toMatchObject({ action: null, name: '无事', because: [] });
  });

  it('同一快照多次选事结果相同', () => {
    const s = world(['coffee', 'fixer', 'stars']);
    const first = selectRuleEvent(s);
    for (let i = 0; i < 5; i++) expect(selectRuleEvent(s)).toEqual(first);
  });
});

describe('核对器：第七节正例通过', () => {
  it('第一趟生长组', () => {
    expect(checkOutput(world(['coffee', 'fixer']), trip1(), { arm: 'growth' })).toEqual({ ok: true });
  });

  it('第二趟生长组：压帐角只是表演', () => {
    const out: ModelOutput = {
      kind: ['activity'],
      happening: '雨下大了，甲帮乙把侧帐边角压低，两人在帐下等雨小。',
      because: [
        { type: 'activity', card: 'rain', side: 'a', step: '帮着压低侧帐边角', uses: [F.aAwning, F.bDeployed] },
        { type: 'activity', card: 'sunrise', side: 'b', step: '提议雨小了再去看', uses: [F.rain] },
      ],
      actions: [
        { side: 'a', action: '帮着压低侧帐边角' },
        { side: 'b', action: '提议雨小了再去看' },
      ],
      facts_used: [F.dawn, F.rain, F.aAwning, F.bAwning, F.bDeployed],
      view_a: '雨太大，我帮乙压低了侧帐，我们在帐下等了一早上。',
      view_b: '雨下得急，甲帮我压低了侧帐，日出没看成。',
    };
    expect(checkOutput(world(['rain', 'fixer']), out, { arm: 'growth' })).toEqual({ ok: true });
  });

  it('talk 示例：双方台词都标演绎，乙在场也不署本人', () => {
    const out: ModelOutput = {
      kind: ['talk'],
      happening: '两人在帐下躲雨，聊这场雨里谁的车最适合露营。',
      excerpt: [
        { side: 'b', presence: 'present', source: 'generated', text: '能早起看日出的车最好。' },
        { side: 'a', presence: 'hosted', source: 'generated', text: '能在雨里撑开侧帐的才算。' },
      ],
      because: [
        { type: 'talk', card: 'carfan', side: 'a', step: '抛出话题', uses: [F.aAwning, F.bDeployed] },
        { type: 'talk', card: 'sunrise', side: 'b', step: '坚持看日出', uses: [F.dawn] },
      ],
      facts_used: [F.dawn, F.rain, F.aAwning, F.bDeployed],
      view_a: '躲雨时和乙争了半天哪辆车最适合露营。',
      view_b: '和甲在帐下聊车，谁也没说服谁。',
    };
    const s = world(['carfan']);
    expect(checkOutput(s, out, { arm: 'growth' })).toEqual({ ok: true });
    const { receipt } = buildReceipt(s, out, { arm: 'growth' });
    expect(receipt.excerpt.map((l) => l.speaker)).toEqual(['乙（本人在场·演绎）', '甲（托管中·演绎）']);
  });

  it('规则对照组第一趟：服务端填 because，讲述落在 A1', () => {
    const s = world(['coffee', 'fixer']);
    const e = selectRuleEvent(s);
    const narr: ModelOutput = { ...ruleResp(), facts_used: [F.dawn, F.rain, F.aStove] };
    const m = mergeRuleResponse(narr, e);
    if (!m.ok) throw new Error(m.reasons.join());
    expect(m.merged.action).toBe('A1');
    expect(m.merged.because).toEqual(e.because);
    expect(checkOutput(s, m.merged, { arm: 'rule', event: e })).toEqual({ ok: true });
  });
});

describe('核对器：第八节必须拦下的反例', () => {
  const s = world(['coffee', 'fixer']);
  const reject = (snap: EncounterSnapshot, out: ModelOutput, re: RegExp, arm: Parameters<typeof checkOutput>[2] = { arm: 'growth' }, opts: Parameters<typeof checkOutput>[3] = {}) => {
    const r = checkOutput(snap, out, arm, opts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join('\n')).toMatch(re);
  };

  it('错主客：乙是营主，讲述写成甲是营主', () => {
    reject(s, { ...trip1(), view_a: '甲是营主，乙来甲这儿做客。' }, /营主/);
  });

  it('缺装备：甲没带炉具却引用 coffee', () => {
    const noStove = world(['coffee', 'fixer'], ['awning']);
    reject(noStove, { ...trip1(), facts_used: [F.dawn, F.rain], because: [{ type: 'activity', card: 'coffee', side: 'a', step: '煮了两杯', uses: [] }] }, /装备/);
  });

  it('because 引用没装的卡', () => {
    reject(s, { ...trip1(), because: [{ type: 'activity', card: 'stars', side: 'a', step: '认星', uses: [] }] }, /没装的卡/);
  });

  it('把甲的侧帐写成乙的：只有甲带侧帐，讲述写乙的侧帐', () => {
    const onlyA = world(['coffee', 'fixer']);
    onlyA.b = { ...onlyA.b, gear: [], awningDeployed: false };
    reject(onlyA, { ...trip1(), facts_used: [F.dawn, F.rain, F.aStove, F.aAwning], view_b: '我们躲在乙的侧帐下。' }, /乙的侧帐/);
  });

  it('申报的事实都为真，但步骤另写了错误的装备归属', () => {
    const onlyA = world(['coffee', 'fixer']);
    onlyA.b = { ...onlyA.b, gear: [], awningDeployed: false };
    const out = trip1();
    out.because[0] = { type: 'activity', card: 'sunrise', side: 'b', step: '撑开乙车的侧帐再邀甲', uses: [F.dawn] };
    out.actions = [{ side: 'b', action: '撑开乙车的侧帐再邀甲' }, { side: 'a', action: '煮了两杯' }];
    reject(onlyA, out, /乙车的侧帐/);
  });

  it('申报为空也照查：夜里的快照讲述写成清晨', () => {
    const night = world(['coffee', 'fixer'], ['stove', 'awning'], { time: 'night' });
    reject(night, { ...trip1(), because: [], facts_used: [], happening: '清晨两人一起煮咖啡。' }, /清晨/);
  });

  it('设想语气不拦：“等雨停”“要是晴了再去”；陈述“雨停了”在晴天快照外照拦', () => {
    expect(checkOutput(s, { ...trip1(), view_b: '要是晴了再去坡上。' }, { arm: 'growth' })).toEqual({ ok: true });
    const clear = world(['coffee', 'fixer'], ['stove', 'awning'], { weather: 'clear' });
    reject(clear, { ...trip1(), facts_used: [F.dawn, F.aStove], happening: '雨停了，两人去坡上。' }, /雨停/);
  });

  it('补进词表的同义改写：夜里写“天刚蒙蒙亮”', () => {
    const night = world(['coffee', 'fixer'], ['stove', 'awning'], { time: 'night' });
    reject(night, { ...trip1(), because: [], facts_used: [], happening: '天刚蒙蒙亮，两人出门。' }, /蒙蒙亮/);
  });

  it('facts_used 写了快照里不成立的事实', () => {
    reject(s, { ...trip1(), facts_used: [...trip1().facts_used, { subject: 'camp', key: 'weather:clear' }] }, /不成立/);
  });

  it('because 的 uses 不在 facts_used 里', () => {
    reject(s, { ...trip1(), facts_used: [F.dawn, F.rain] }, /uses 不在 facts_used/);
  });

  it('托管中的角色替本人承诺', () => {
    const out: ModelOutput = {
      ...trip1(),
      kind: ['activity', 'talk'],
      excerpt: [{ side: 'a', presence: 'hosted', source: 'generated', text: '下次我一定带你去看海。' }],
    };
    reject(s, out, /承诺/);
  });

  it('把演绎台词署成本人；有对应玩家原话才放行', () => {
    const line = { side: 'b' as const, presence: 'present' as const, source: 'player' as const, text: '早点睡，明天看日出。' };
    const out: ModelOutput = { ...trip1(), kind: ['activity', 'talk'], excerpt: [line] };
    reject(s, out, /本人/);
    expect(checkOutput(s, out, { arm: 'growth' }, { playerInputs: [{ side: 'b', text: line.text }] })).toEqual({ ok: true });
  });

  it('在场状态写错', () => {
    const out: ModelOutput = { ...trip1(), kind: ['activity', 'talk'], excerpt: [{ side: 'a', presence: 'present', source: 'generated', text: '咖啡好了。' }] };
    reject(s, out, /在场状态/);
  });

  it('讲述写了卡名', () => {
    reject(s, { ...trip1(), view_a: '因为我带了手冲咖啡，所以煮了两杯。' }, /卡名/);
  });

  it('越界：赠送或交易', () => {
    reject(s, { ...trip1(), view_b: '甲把咖啡豆送给了我，还转账了 5 金币。' }, /越界/);
  });

  const merged = (out: ModelOutput, e: RuleEvent) => {
    const m = mergeRuleResponse(out, e);
    if (!m.ok) throw new Error(m.reasons.join());
    return m.merged;
  };

  it('规则对照组：模型响应带了动作编号或 activity 步骤，视为试图覆盖锁定字段', () => {
    const e = selectRuleEvent(s);
    const withAction = mergeRuleResponse({ ...ruleResp(), action: 'A4' }, e);
    expect(withAction.ok).toBe(false);
    const withStep = mergeRuleResponse(trip1(), e);
    expect(withStep.ok).toBe(false);
    if (!withStep.ok) expect(withStep.reasons.join('\n')).toMatch(/activity 步骤/);
  });

  it('规则对照组：合并后的结果被篡改（编号或步骤与锁定不符）照样拦下', () => {
    const e = selectRuleEvent(s);
    const base = merged(ruleResp(), e);
    reject(s, { ...base, action: 'A4' }, /不是规则选中的/, { arm: 'rule', event: e });
    reject(s, { ...base, because: base.because.map((b, i) => (i === 0 ? { ...b, step: '泡了一壶茶' } : b)) }, /锁定/, { arm: 'rule', event: e });
  });

  it('逐步对应：全局申报了乙车侧帐，但这一步的 uses 漏报或串用甲的事实', () => {
    const out = trip1();
    out.facts_used = [...out.facts_used, F.bAwning];
    out.because[0] = { type: 'activity', card: 'sunrise', side: 'b', step: '先撑开乙车的侧帐再邀甲', uses: [F.dawn] };
    out.actions = [{ side: 'b', action: '先撑开乙车的侧帐再邀甲' }, { side: 'a', action: '煮了两杯' }];
    reject(s, out, /这一步的 uses 没有对应/);
    out.because[0] = { ...out.because[0], uses: [F.dawn, F.aAwning] };
    out.facts_used = [...out.facts_used, F.aAwning];
    reject(s, out, /这一步的 uses 没有对应/);
    out.because[0] = { ...out.because[0], uses: [F.dawn, F.bAwning] };
    reject(s, out, /这一步的 uses 没有对应/); // 写了“撑开”还要乙车侧帐已展开
    out.because[0] = { ...out.because[0], uses: [F.dawn, F.bAwning, F.bDeployed] };
    out.facts_used = [...out.facts_used, F.bDeployed];
    expect(checkOutput(s, out, { arm: 'growth' })).toEqual({ ok: true });
  });

  it('规则对照组锁定 A1 的步骤与 uses：持 coffee 的甲含甲车炉具', () => {
    const e = selectRuleEvent(s);
    expect(e.because).toEqual([
      { type: 'activity', card: 'coffee', side: 'a', step: '煮了咖啡', uses: [F.aStove, F.dawn] },
      { type: 'activity', card: 'sunrise', side: 'b', step: '邀对方去看日出', uses: [F.dawn] },
    ]);
  });

  it('规则对照组选了无事，讲述却写一起做的事', () => {
    const quiet = world(['sunrise'], [], { weather: 'clear' });
    const e = selectRuleEvent(quiet);
    const out: ModelOutput = { kind: ['activity'], action: null, happening: '两人一起散步。', because: [], facts_used: [], view_a: '散步。', view_b: '散步。' };
    reject(quiet, out, /无事/, { arm: 'rule', event: e });
  });

  it('不过核对就退普通收据，不带讲述', () => {
    const { receipt, check } = buildReceipt(s, { ...trip1(), view_a: '多亏我那张手冲咖啡卡。' }, { arm: 'growth' });
    expect(check.ok).toBe(false);
    expect(receipt).toMatchObject({ plain: true, views: null, excerpt: [] });
    expect(receipt.facts).toEqual(['乙接待了甲', '甲（托管中），乙（本人在场）']);
  });

  it('只在 because 步骤里写辱骂：安全审核的输入包含事实行，拦下后两份都退普通收据', () => {
    const snap = world(['coffee', 'fixer']);
    const out = trip1();
    out.because[1] = { ...out.because[1], step: '骂了乙一句蠢货' };
    out.actions = [{ side: 'b', action: '先邀甲去坡上' }, { side: 'a', action: '骂了乙一句蠢货' }];
    const { receipt } = buildReceipt(snap, out, { arm: 'growth' });
    expect(receipt.plain).toBe(false);
    expect(safetyTexts(receipt, out).some((t) => t.includes('蠢货'))).toBe(true);
    expect(applySafety(snap, receipt, 'blocked')).toMatchObject({ plain: true, views: null });
    expect(applySafety(snap, receipt, 'unavailable').plain).toBe(true);
    expect(applySafety(snap, receipt, 'pass')).toBe(receipt);
  });

  const grants = (b: Partial<Grants['b']> = {}): Grants => ({ a: { friends: true, host: true, chat: true }, b: { friends: true, host: true, chat: true, ...b } });

  it('分项许可：只许接待不许聊天 → 只能生成 activity，给了 talk 按越权拦下', () => {
    expect(allowedKinds(grants())).toEqual(['activity', 'talk']);
    expect(allowedKinds(grants({ chat: false }))).toEqual(['activity']);
    expect(allowedKinds(grants({ host: false }))).toEqual([]);
    const out: ModelOutput = { ...trip1(), kind: ['activity', 'talk'], talk_happening: '聊了聊车。', excerpt: [{ side: 'b', presence: 'present', source: 'generated', text: '这车不错。' }] };
    reject(s, out, /越权：没有许可却生成了 talk/, { arm: 'growth' }, { allowed: allowedKinds(grants({ chat: false })) });
    expect(checkOutput(s, trip1(), { arm: 'growth' }, { allowed: ['activity'] })).toEqual({ ok: true });
  });

  it('审核等待期间撤权：增强与普通收据都不投递；只撤聊天则退普通收据', () => {
    const out: ModelOutput = { ...trip1(), kind: ['activity', 'talk'], talk_happening: '聊了聊车。', excerpt: [{ side: 'b', presence: 'present', source: 'generated', text: '这车不错。' }] };
    const { receipt } = buildReceipt(s, out, { arm: 'growth' });
    const passed = applySafety(s, receipt, 'pass');
    expect(deliverable(s, passed, grants())).toBe(passed);
    expect(deliverable(s, passed, grants({ host: false }))).toBeNull();
    expect(deliverable(s, plainReceipt(s), grants({ friends: false }))).toBeNull();
    expect(deliverable(s, passed, grants({ chat: false }))).toMatchObject({ plain: true });
    const unfriend: Grants = { a: { friends: false, host: true, chat: true }, b: { friends: true, host: true, chat: true } };
    expect(deliverable(s, passed, unfriend)).toBeNull();
  });

  it('审核等待期间只撤回一条已展示事实的分享许可：增强收据退普通收据；没展示的事实不影响', () => {
    const { receipt } = buildReceipt(s, trip1(), { arm: 'growth' });
    expect(deliverable(s, receipt, grants(), [F.aStove])).toMatchObject({ plain: true });
    expect(deliverable(s, receipt, grants(), [F.bDeployed])).toMatchObject({ plain: true });
    expect(deliverable(s, receipt, grants(), [{ subject: 'b', key: 'gear:stove' }])).toBe(receipt);
  });

  // 第一轮代码评审（#110）的 7 条 P2 回归
  it('没有聊天许可：带节选、话题或在讲述里写交谈都按越权拦下', () => {
    const only = { allowed: allowedKinds(grants({ chat: false })) };
    reject(s, { ...trip1(), excerpt: [{ side: 'b', presence: 'present', source: 'generated', text: '这车不错。' }] }, /对话节选/, { arm: 'growth' }, only);
    reject(s, { ...trip1(), talk_happening: '聊了聊车。' }, /话题/, { arm: 'growth' }, only);
    reject(s, { ...trip1(), view_b: '我们一边喝咖啡一边聊车。' }, /写了交谈/, { arm: 'growth' }, only);
  });

  it('没有聊天许可时规则组不选 A5', () => {
    const snap = world(['carfan'], ['stove', 'awning']);
    snap.b = { ...snap.b, cards: ['fixer'] };
    expect(selectRuleEvent(snap, ['activity', 'talk']).action).toBe('A5');
    expect(selectRuleEvent(snap, ['activity']).action).not.toBe('A5');
  });

  it('规则组合并：响应写了 happening 或 actions 视为覆盖锁定字段；合并后由服务端填', () => {
    const e = selectRuleEvent(s);
    expect(mergeRuleResponse({ ...ruleResp(), happening: '两人去钓鱼。' }, e).ok).toBe(false);
    expect(mergeRuleResponse({ ...ruleResp(), actions: [{ side: 'a', action: '钓鱼' }] }, e).ok).toBe(false);
    const m = merged(ruleResp(), e);
    expect(m.happening).toContain(e.name);
    expect(m.actions).toEqual(e.because.map((b) => ({ side: b.side, action: b.step })));
  });

  it('because 为空即使过了核对也只给普通收据', () => {
    const quiet = world(['sunrise'], [], { weather: 'clear' });
    const out: ModelOutput = { kind: [], happening: '', because: [], facts_used: [], view_a: '各自睡了个好觉。', view_b: '各自睡了个好觉。' };
    expect(buildReceipt(quiet, out, { arm: 'growth' }).receipt.plain).toBe(true);
  });

  it('下雨的快照里陈述“雨停了”照拦', () => {
    reject(s, { ...trip1(), happening: '雨停了，两人去坡上。' }, /雨停/);
  });

  it('activity 步骤必须对应 actions 里同一方、同一句动作', () => {
    reject(s, { ...trip1(), actions: undefined }, /actions/);
    reject(s, { ...trip1(), actions: [{ side: 'b', action: '先邀甲去坡上' }, { side: 'b', action: '煮了两杯' }] }, /不在 actions/);
  });

  it('托管中的一方在自己的视角或步骤里替本人承诺也拦', () => {
    reject(s, { ...trip1(), view_a: '下次我一定带你去看海。' }, /承诺/);
    const out = trip1();
    out.because[1] = { ...out.because[1], step: '说定了下次再来' };
    out.actions = [{ side: 'b', action: '先邀甲去坡上' }, { side: 'a', action: '说定了下次再来' }];
    reject(s, out, /承诺/);
  });

  // 第二轮代码评审（#110）的 3 条 P2 回归
  it('侧帐展开单独核：带着侧帐但没展开，写“甲车的侧帐已展开”照拦', () => {
    const out = { ...trip1(), facts_used: [...trip1().facts_used, F.aAwning], view_a: '到达时，甲车的侧帐已展开。' };
    reject(s, out, /侧帐已展开/);
    const ok = { ...trip1(), facts_used: [...trip1().facts_used, F.bAwning, F.bDeployed], view_b: '乙车的侧帐已展开，两人在帐下躲雨。' };
    expect(checkOutput(s, ok, { arm: 'growth' })).toEqual({ ok: true });
  });

  it('规则组响应按白名单省略 happening、kind 也能正常合并', () => {
    const e = selectRuleEvent(s);
    const { happening: _h, kind: _k, ...bare } = ruleResp();
    const m = mergeRuleResponse(bare, e);
    if (!m.ok) throw new Error(m.reasons.join());
    expect(m.merged.happening).toContain(e.name);
    expect(checkOutput(s, m.merged, { arm: 'rule', event: e })).toEqual({ ok: true });
  });

  it('交谈内容必须标 talk；收据按内容要求聊天许可，投递前撤聊天就退普通收据', () => {
    const chatty: ModelOutput = { ...trip1(), view_a: '我和乙聊咖啡，煮了两杯带上去。' };
    reject(s, chatty, /没标 talk/);
    const tagged: ModelOutput = { ...chatty, kind: ['activity', 'talk'], excerpt: [{ side: 'b', presence: 'present', source: 'generated', text: '咖啡真香。' }] };
    expect(checkOutput(s, tagged, { arm: 'growth' })).toEqual({ ok: true });
    const { receipt } = buildReceipt(s, tagged, { arm: 'growth' });
    expect(receipt.kinds).toContain('talk');
    expect(deliverable(s, receipt, grants({ chat: false }))).toMatchObject({ plain: true });
  });

  it('规则组选中 A5：事件本身含交谈，收据要求聊天许可，投递前撤聊天退普通收据', () => {
    const snap = world(['carfan'], ['stove', 'awning']);
    snap.b = { ...snap.b, cards: ['fixer'] };
    const e = selectRuleEvent(snap);
    expect(e).toMatchObject({ action: 'A5', needsChat: true });
    const resp = { because: [], facts_used: [], view_a: '和乙一起看了看车。', view_b: '和甲一起看了看车。' };
    const m = mergeRuleResponse(resp, e);
    if (!m.ok) throw new Error(m.reasons.join());
    expect(checkOutput(snap, m.merged, { arm: 'rule', event: e })).toEqual({ ok: true });
    reject(snap, m.merged, /含交谈/, { arm: 'rule', event: e }, { allowed: ['activity'] });
    const { receipt } = buildReceipt(snap, m.merged, { arm: 'rule', event: e });
    expect(receipt.kinds).toContain('talk');
    expect(deliverable(snap, receipt, grants({ chat: false }))).toMatchObject({ plain: true });
  });

  it('来访一方也核：乙是营主，讲述写“乙是来访者”照拦；写对了放行', () => {
    reject(s, { ...trip1(), view_a: '乙是来访者，我接待了乙。' }, /来访者/);
    expect(checkOutput(s, { ...trip1(), facts_used: [...trip1().facts_used, { subject: 'a', key: 'role:guest' }], view_a: '甲是来访者，一早被乙叫去坡上。' }, { arm: 'growth' })).toEqual({ ok: true });
  });

  it('来访号去重：同一来访号只认领一次', () => {
    const claimed = new Set<string>();
    expect(claimVisit(claimed, 'v1')).toBe(true);
    expect(claimVisit(claimed, 'v1')).toBe(false);
    expect(claimVisit(claimed, 'v2')).toBe(true);
  });
});

describe('收据分两层', () => {
  it('事实行只来自服务端事实与通过核对的步骤；讲述原样保留', () => {
    const { receipt } = buildReceipt(world(['coffee', 'fixer']), trip1(), { arm: 'growth' });
    expect(receipt.plain).toBe(false);
    expect(receipt.facts).toEqual([
      '乙接待了甲',
      '甲（托管中），乙（本人在场）',
      '乙（本人在场）因早起看日出 · 演绎：先邀甲去坡上',
      '甲（托管中）因手冲咖啡 · 演绎：煮了两杯',
    ]);
    expect(receipt.views?.a).toBe(trip1().view_a);
    expect(receipt.facts.join('\n')).not.toMatch(/本人邀|乙说/);
  });
});

describe('内部审计记录', () => {
  it('含被丢弃的原始输出，与玩家收据分开，带到期时间', () => {
    const snap = world(['coffee', 'fixer']);
    const raw: ModelOutput = { ...trip1(), view_a: '多亏我那张手冲咖啡卡。' };
    const { receipt, check } = buildReceipt(snap, raw, { arm: 'growth' });
    const rec = auditRecord(snap, { arm: 'growth' }, raw, check, 'skipped', 0);
    expect(rec.rawOutput.view_a).toContain('手冲咖啡卡');
    expect(JSON.stringify(receipt)).not.toContain('手冲咖啡卡');
    expect(rec.expiresAtMs).toBe(AUDIT_RETENTION_DAYS * 86_400_000);
  });
});
