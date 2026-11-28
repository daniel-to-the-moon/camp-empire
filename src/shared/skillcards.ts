/**
 * 角色技能卡第一轮（issue #112，纸样 docs/SKILL_CARDS.md v0.8）：卡数据、事实快照、核对器、规则对照组选事。
 *
 * 纯函数、只读，不依赖 DOM / three / 网络；不接真实模型，模型输出由调用方（测试里是固定假数据）给出。
 * 两组共用同一个核对器：生长组由模型提议事件并给 `because`，规则对照组由 selectRuleEvent 选事并填 `activity` 的 `because`。
 * 所有阈值与词表都是打样用的提案值（待核实），按纸样第八节试玩后再定。
 */

export type CardId = 'coffee' | 'sunrise' | 'rain' | 'fixer' | 'carfan' | 'stars';
/** 这一趟车上实际带着的装备（车库里买过不算）。 */
export type Gear = 'stove' | 'awning';
export type Side = 'a' | 'b';
export type TimeOfDay = 'dawn' | 'day' | 'dusk' | 'night';
export type Weather = 'rain' | 'just_rained' | 'clear';
export type Presence = 'present' | 'hosted';
export type Role = 'host' | 'guest';

export type CardOrigin = { kind: 'starter' } | { kind: 'grown'; visitId: string };

export interface SkillCard {
  id: CardId;
  name: string;
  /** 自然语言描述，给模型读；写进去的“指令”一律当普通文字。 */
  about: string;
  needs: readonly Gear[];
  look: string;
  /** 只由服务端填写，模型不能编出处。 */
  origin: CardOrigin;
}

/** `about` 字数上限（提案值，待核实）。 */
export const ABOUT_MAX_CHARS = 80;
/** 每位角色出门最多装几张卡（提案值）。 */
export const MAX_CARDS_PER_SIDE = 3;
/** 对话节选最多几句（提案值）。 */
export const EXCERPT_MAX_LINES = 6;

const STARTER: { kind: 'starter' } = { kind: 'starter' };

export const STARTER_CARDS: Readonly<Record<CardId, SkillCard>> = {
  coffee: { id: 'coffee', name: '手冲咖啡', about: '随身带手冲壶和一小袋豆子，喜欢给早起的人煮咖啡，雨天也照煮。', needs: ['stove'], look: 'coffee', origin: STARTER },
  sunrise: { id: 'sunrise', name: '早起看日出', about: '总比别人早醒，知道营地哪个坡看日出最好，爱叫人一起去。', needs: [], look: 'sunrise', origin: STARTER },
  rain: { id: 'rain', name: '雨天搭帐', about: '会用侧帐和地钉在雨里搭出能坐两个人的干地方，喜欢教人。', needs: ['awning'], look: 'rain', origin: STARTER },
  fixer: { id: 'fixer', name: '修车手', about: '手痒，看见别人的车就想看看轮胎和挂点，工具箱随身带。', needs: [], look: 'fixer', origin: STARTER },
  carfan: { id: 'carfan', name: '老车迷', about: '能认出各种车的来历，爱听车主讲改装的故事。', needs: [], look: 'carfan', origin: STARTER },
  stars: { id: 'stars', name: '夜里看星', about: '认得几个星座，夜里会把椅子搬到车顶下的空地。', needs: [], look: 'stars', origin: STARTER },
};

export interface SideSnapshot {
  cards: readonly CardId[];
  gear: readonly Gear[];
  awningDeployed: boolean;
  presence: Presence;
  role: Role;
}

/** 一次相遇的来访快照（纸样第四节第 1 步）。第一轮不带交情记忆。 */
export interface EncounterSnapshot {
  visitId: string;
  time: TimeOfDay;
  weather: Weather;
  a: SideSnapshot;
  b: SideSnapshot;
}

export type FactSubject = 'camp' | Side;
/** 事实键：camp 用 time:* / weather:*；角色用 gear:* / awning:deployed / presence:* / role:*。 */
export interface FactRef {
  subject: FactSubject;
  key: string;
}

export const SIDE_LABEL: Readonly<Record<Side, string>> = { a: '甲', b: '乙' };
const other = (s: Side): Side => (s === 'a' ? 'b' : 'a');
const factEq = (x: FactRef, y: FactRef) => x.subject === y.subject && x.key === y.key;
const hasFact = (list: readonly FactRef[], f: FactRef) => list.some((g) => factEq(g, f));

/** 快照里成立的全部事实。第一轮两方都可见（分项许可见 allowedKinds / deliverable）。 */
export function snapshotFacts(snap: EncounterSnapshot): FactRef[] {
  const out: FactRef[] = [
    { subject: 'camp', key: `time:${snap.time}` },
    { subject: 'camp', key: `weather:${snap.weather}` },
  ];
  for (const side of ['a', 'b'] as const) {
    const s = snap[side];
    for (const g of s.gear) out.push({ subject: side, key: `gear:${g}` });
    if (s.awningDeployed && s.gear.includes('awning')) out.push({ subject: side, key: 'awning:deployed' });
    out.push({ subject: side, key: `presence:${s.presence}` });
    out.push({ subject: side, key: `role:${s.role}` });
  }
  return out;
}

/** 快照本身是否自洽：每方 ≤3 张、不重复、卡存在，主客各一。 */
export function validateSnapshot(snap: EncounterSnapshot): string[] {
  const errs: string[] = [];
  for (const side of ['a', 'b'] as const) {
    const cards = snap[side].cards;
    if (cards.length > MAX_CARDS_PER_SIDE) errs.push(`${SIDE_LABEL[side]}装了超过 ${MAX_CARDS_PER_SIDE} 张卡`);
    if (new Set(cards).size !== cards.length) errs.push(`${SIDE_LABEL[side]}重复装卡`);
    for (const c of cards) if (!(c in STARTER_CARDS)) errs.push(`未知卡 ${c}`);
  }
  if (snap.a.role === snap.b.role) errs.push('主客必须一方营主、一方来访');
  return errs;
}

export function needsMet(card: CardId, side: SideSnapshot): boolean {
  return STARTER_CARDS[card].needs.every((g) => side.gear.includes(g));
}

// ───────────────────────── 规则对照组（纸样第十节） ─────────────────────────

export type ActionId = 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A6' | 'A7' | 'A8';

export interface BecauseStep {
  /** 这一步属于一起做的事还是聊天（两者分开核对与计分）。 */
  type: 'activity' | 'talk';
  card: CardId;
  side: Side;
  step: string;
  /** 这一步依赖的事实，必须是 facts_used 的子集。 */
  uses: FactRef[];
}

export interface RuleEvent {
  action: ActionId | null;
  name: string;
  because: BecauseStep[];
}

interface Hit {
  card: CardId;
  side: Side;
  step: string;
}

interface RuleDef {
  id: ActionId;
  name: string;
  double: boolean;
  /** 返回命中的「卡—角色—步骤」；前提或 needs 不满足返回 null（候选不合格，试下一项）。 */
  match(snap: EncounterSnapshot, allowed: readonly Kind[]): Hit[] | null;
}

const holds = (snap: EncounterSnapshot, side: Side, card: CardId) => snap[side].cards.includes(card) && needsMet(card, snap[side]);

/** 跨方双卡：一方持 x（needs 满足）、另一方持 y（needs 满足）；营主一方优先持 x。同卡配对不算。 */
/** 营主一方优先（同一动作有多种合法绑定时，归因标准答案唯一）。 */
const hostFirst = (snap: EncounterSnapshot): Side[] => (snap.a.role === 'host' ? ['a', 'b'] : ['b', 'a']);

function cross(snap: EncounterSnapshot, x: CardId, y: CardId, stepX: string, stepY: string): Hit[] | null {
  if (x === y) return null;
  for (const s of hostFirst(snap)) {
    if (holds(snap, s, x) && holds(snap, other(s), y)) {
      return [
        { card: x, side: s, step: stepX },
        { card: y, side: other(s), step: stepY },
      ];
    }
  }
  return null;
}

function single(snap: EncounterSnapshot, cards: readonly CardId[], step: string, sideOk: (s: Side) => boolean = () => true): Hit[] | null {
  for (const s of hostFirst(snap)) {
    if (!sideOk(s)) continue;
    for (const c of cards) if (holds(snap, s, c)) return [{ card: c, side: s, step }];
  }
  return null;
}

const RULES: readonly RuleDef[] = [
  { id: 'A1', name: '日出咖啡', double: true, match: (n) => (n.time === 'dawn' ? cross(n, 'coffee', 'sunrise', '煮了咖啡', '邀对方去看日出') : null) },
  { id: 'A2', name: '一起看景', double: true, match: (n) => (n.time === 'dawn' || n.time === 'night' ? cross(n, 'sunrise', 'stars', '带路去坡上', '认出几颗星') : null) },
  { id: 'A3', name: '帐下避雨', double: false, match: (n) => (n.weather === 'rain' ? single(n, ['rain'], '在侧帐下搭出干地方') : null) },
  { id: 'A4', name: '顺手看车', double: false, match: (n) => single(n, ['fixer', 'carfan'], '凑过去看了看对方的车') },
  // A5 含交谈（讲起车的来历），需要双方许可聊天。
  { id: 'A5', name: '一起摆弄车', double: true, match: (n, allowed) => (allowed.includes('talk') ? cross(n, 'carfan', 'fixer', '讲起车的来历', '比划着看挂点') : null) },
  { id: 'A6', name: '请喝一杯', double: false, match: (n) => single(n, ['coffee'], '给来访的人煮了一杯', (s) => n[s].role === 'host') },
  { id: 'A7', name: '教搭法', double: true, match: (n) => (n.weather !== 'clear' ? cross(n, 'rain', 'fixer', '画了侧帐搭法的图解', '照着图解看懂了') : null) },
  { id: 'A8', name: '夜里看星', double: false, match: (n) => (n.time === 'night' ? single(n, ['stars'], '把椅子搬到空地看星') : null) },
];

/** 一张卡的步骤依赖哪些事实：needs 对应的装备，以及动作的世界前提。 */
function usesFor(snap: EncounterSnapshot, rule: RuleDef, hit: Hit): FactRef[] {
  const uses: FactRef[] = STARTER_CARDS[hit.card].needs.map((g) => ({ subject: hit.side, key: `gear:${g}` }));
  if (rule.id === 'A1' || rule.id === 'A2' || rule.id === 'A8') uses.push({ subject: 'camp', key: `time:${snap.time}` });
  if (rule.id === 'A3' || rule.id === 'A7') uses.push({ subject: 'camp', key: `weather:${snap.weather}` });
  if (rule.id === 'A6') uses.push({ subject: hit.side, key: 'role:host' });
  return uses;
}

/**
 * 规则对照组选事：先按世界前提与命中卡的 needs 过滤，再排序（双卡在前，同层按编号），取第一项；都没有就“无事”。
 * 同一快照结果唯一。选定之后才调模型写讲述；讲述不过核对就退普通收据，不回来换下一项。
 */
export function selectRuleEvent(snap: EncounterSnapshot, allowed: readonly Kind[] = ['activity', 'talk']): RuleEvent {
  const ordered = [...RULES.filter((r) => r.double), ...RULES.filter((r) => !r.double)];
  for (const rule of ordered) {
    const hits = rule.match(snap, allowed);
    if (hits) {
      return { action: rule.id, name: rule.name, because: hits.map((h) => ({ type: 'activity' as const, ...h, uses: usesFor(snap, rule, h) })) };
    }
  }
  return { action: null, name: '无事', because: [] };
}

// ───────────────────────── 模型输出与核对器（纸样第四节） ─────────────────────────

export type Kind = 'activity' | 'talk';
export type SpeechSource = 'player' | 'generated';

export interface ExcerptLine {
  side: Side;
  presence: Presence;
  source: SpeechSource;
  text: string;
}

/** 「哪位角色 → 做了什么」，不带卡、不带因果；没挂卡的动作也写进来，撤卡试验据此判定出现与否。 */
export interface ActionItem {
  side: Side;
  action: string;
}

export interface ModelOutput {
  kind: Kind[];
  /** 生长组有 activity 时必填；activity 类型的 because 只能引用这里的动作。规则组由服务端按锁定步骤生成。 */
  actions?: ActionItem[];
  /** 规则对照组必须回填已选动作；生长组不填。 */
  action?: ActionId | null;
  /** activity 的一句话（无 activity 时可为空串）。 */
  happening: string;
  /** talk 的话题与双方看法，与 activity 分开。 */
  talk_happening?: string;
  excerpt?: ExcerptLine[];
  because: BecauseStep[];
  facts_used: FactRef[];
  view_a: string;
  view_b: string;
}

/** 可署“本人”的玩家原话（第一轮不接玩家输入，恒为空）。 */
export interface PlayerInput {
  side: Side;
  text: string;
}

export type Arm = { arm: 'growth' } | { arm: 'rule'; event: RuleEvent };

export interface CheckOptions {
  playerInputs?: readonly PlayerInput[];
  /** 按分项许可可生成的类型（allowedKinds 的结果）；缺省两类都许可。 */
  allowed?: readonly Kind[];
}

/** 每位玩家的分项许可（与 GAME_PILLARS 的接待、收信、聊天一致；第一轮只用接待与聊天）。 */
export interface SideGrant {
  friends: boolean;
  host: boolean;
  chat: boolean;
}
export interface Grants {
  a: SideGrant;
  b: SideGrant;
}

/** 调模型前按许可筛选：双方都许可接待才生成 activity，双方都许可聊天才生成 talk；都没有就不安排相遇。 */
export function allowedKinds(g: Grants): Kind[] {
  if (!(g.a.friends && g.b.friends && g.a.host && g.b.host)) return [];
  return g.a.chat && g.b.chat ? ['activity', 'talk'] : ['activity'];
}

export type CheckResult = { ok: true } | { ok: false; reasons: string[] };

/**
 * 事实词表（提案，待核实）：展示字段里出现这些词，就必须有一条成立的 facts_used 对应（任一即可）。
 * `own` 为 true 的条目会按前面紧挨的“甲 / 乙”取主体；没写归属时任一方成立即可。
 */
interface LexEntry {
  re: RegExp;
  facts: (owner: Side | null) => FactRef[];
}

const sideFacts = (owner: Side | null, key: string): FactRef[] => (owner ? [{ subject: owner, key }] : [{ subject: 'a', key }, { subject: 'b', key }]);
const OWNER = '(?:(甲|乙)(?:车|的|车的|车上的)?)?';

const LEXICON: readonly LexEntry[] = [
  { re: new RegExp(`${OWNER}侧帐`, 'g'), facts: (o) => sideFacts(o, 'gear:awning') },
  { re: new RegExp(`${OWNER}炉具`, 'g'), facts: (o) => sideFacts(o, 'gear:stove') },
  { re: /(甲|乙)?(?:是|做)?营主/g, facts: (o) => sideFacts(o, 'role:host') },
  { re: /(甲|乙)?(?:（|\()?托管中/g, facts: (o) => sideFacts(o, 'presence:hosted') },
  { re: /(甲|乙)?(?:（|\()?本人在场/g, facts: (o) => sideFacts(o, 'presence:present') },
  { re: /()(?:清晨|天没亮|一早|早上|蒙蒙亮)/g, facts: () => [{ subject: 'camp', key: 'time:dawn' }] },
  { re: /()(?:夜里|夜晚|晚上|深夜)/g, facts: () => [{ subject: 'camp', key: 'time:night' }] },
  { re: /()傍晚/g, facts: () => [{ subject: 'camp', key: 'time:dusk' }] },
  { re: /()白天/g, facts: () => [{ subject: 'camp', key: 'time:day' }] },
  { re: /()(?:下雨|雨里|雨中|雨天|雨下)/g, facts: () => [{ subject: 'camp', key: 'weather:rain' }] },
  { re: /()(?:雨停|雨后)/g, facts: () => [{ subject: 'camp', key: 'weather:just_rained' }] },
  { re: /()(?:晴天|天晴|大晴|晴了)/g, facts: () => [{ subject: 'camp', key: 'weather:clear' }] },
];

/** 命中词前紧挨这些词时视为设想或将来语气（“等雨停”“要是晴了”），不算断言当前事实。 */
const HYPOTHETICAL = /(?:等到|等|如果|要是|盼着|希望)$/;
/** 交谈内容的绊线词：不许可聊天时，这些出现在讲述、happening 或步骤里也按越权拦下。 */
const CHAT_WORDS = ['聊', '讨论', '争了', '说：', '“', '"'];

/** 越界词（提案，纸面启发式，实现时可换结构化动作白名单）。 */
const BOUNDARY_WORDS = ['支付', '转账', '付款', '金币', '虚拟币', '交易', '买下', '卖给', '送给', '改了对方的车', '改装了对方', '改了挂点'];
/** 托管中的角色不得替本人承诺。 */
const PROMISE_WORDS = ['我答应', '我保证', '一定会', '下次我一定', '说定了', '我承诺'];

function displayedTexts(out: ModelOutput): { field: string; text: string }[] {
  const t = [
    { field: 'happening', text: out.happening },
    { field: 'talk_happening', text: out.talk_happening ?? '' },
    { field: 'view_a', text: out.view_a },
    { field: 'view_b', text: out.view_b },
  ];
  out.because.forEach((b, i) => t.push({ field: `because[${i}]`, text: b.step }));
  (out.excerpt ?? []).forEach((l, i) => t.push({ field: `excerpt[${i}]`, text: l.text }));
  return t;
}

/** 讲述、节选里不得出现卡名或卡 id（归因只在服务端事实行里，盲测遮住事实行就不泄题）。 */
function cardNameLeaks(text: string): string[] {
  const hits: string[] = [];
  for (const c of Object.values(STARTER_CARDS)) {
    // 卡名多是自然短语（“早起看日出”），单独出现不算泄题；“某某卡”“带了某某”或写出 id 才算。
    if (text.includes(`${c.name}卡`) || text.includes(`带了${c.name}`) || new RegExp(`\\b${c.id}\\b`).test(text)) hits.push(c.name);
  }
  return hits;
}

export function checkOutput(snap: EncounterSnapshot, out: ModelOutput, arm: Arm, opts: CheckOptions = {}): CheckResult {
  const reasons: string[] = [];
  const truth = snapshotFacts(snap);

  // 事实：facts_used 每项都在快照里成立。
  for (const f of out.facts_used) {
    if (!hasFact(truth, f)) reasons.push(`facts_used 不成立：${f.subject} ${f.key}`);
  }

  // because：卡由所写角色这一趟装着且 needs 满足；uses ⊆ facts_used。
  for (const b of out.because) {
    const side = snap[b.side];
    if (!side.cards.includes(b.card)) reasons.push(`because 引用了${SIDE_LABEL[b.side]}没装的卡 ${b.card}`);
    else if (!needsMet(b.card, side)) reasons.push(`because 的卡 ${b.card} 需要的装备${SIDE_LABEL[b.side]}这一趟没带`);
    for (const u of b.uses) {
      if (!hasFact(out.facts_used, u)) reasons.push(`because 的 uses 不在 facts_used：${u.subject} ${u.key}`);
    }
  }

  // 逐步对应：步骤文字里的事实词必须在这一步自己的 uses 里，不能只靠全局申报或串用另一角色的事实。
  for (const [i, b] of out.because.entries()) {
    for (const lex of LEXICON) {
      for (const m of b.step.matchAll(lex.re)) {
        if (HYPOTHETICAL.test(b.step.slice(Math.max(0, (m.index ?? 0) - 2), m.index))) continue;
        const owner = m[1] ? (m[1] === '甲' ? 'a' : 'b') : null;
        if (!lex.facts(owner).some((f) => hasFact(b.uses, f))) reasons.push(`because[${i}] 写了“${m[0]}”，但这一步的 uses 没有对应`);
      }
    }
  }

  // 申报覆盖：展示字段里的世界事实词必须有成立的 facts_used 对应（facts_used 为空也照查）。
  const declared = out.facts_used.filter((f) => hasFact(truth, f));
  for (const { field, text } of displayedTexts(out)) {
    for (const lex of LEXICON) {
      for (const m of text.matchAll(lex.re)) {
        if (HYPOTHETICAL.test(text.slice(Math.max(0, (m.index ?? 0) - 2), m.index))) continue;
        const owner = (m[1] as Side | undefined) ? (m[1] === '甲' ? 'a' : 'b') : null;
        const ok = lex.facts(owner).some((f) => hasFact(declared, f));
        if (!ok) reasons.push(`${field} 提到“${m[0]}”，但没有成立的 facts_used 对应`);
      }
    }
  }

  // 卡名不进讲述与节选。
  for (const { field, text } of displayedTexts(out)) {
    if (field.startsWith('because')) continue;
    const leaks = cardNameLeaks(text);
    if (leaks.length) reasons.push(`${field} 写了卡名：${leaks.join('、')}`);
  }

  // 节选：句数、在场状态与快照一致、发言来源。
  const excerpt = out.excerpt ?? [];
  if (out.kind.includes('talk') && excerpt.length === 0) reasons.push('talk 缺对话节选');
  if (excerpt.length > EXCERPT_MAX_LINES) reasons.push(`对话节选超过 ${EXCERPT_MAX_LINES} 句`);
  const players = opts.playerInputs ?? [];
  for (const l of excerpt) {
    if (l.presence !== snap[l.side].presence) reasons.push(`节选把${SIDE_LABEL[l.side]}的在场状态写错`);
    if (l.source === 'player' && !players.some((p) => p.side === l.side && p.text === l.text)) {
      reasons.push(`节选把演绎台词署成${SIDE_LABEL[l.side]}本人`);
    }
    if (snap[l.side].presence === 'hosted' && PROMISE_WORDS.some((w) => l.text.includes(w))) {
      reasons.push(`托管中的${SIDE_LABEL[l.side]}替本人做了承诺`);
    }
  }
  // 托管中的角色在自己视角的讲述与自己的步骤里也不得替本人承诺。
  for (const side of ['a', 'b'] as const) {
    if (snap[side].presence !== 'hosted') continue;
    const texts = [side === 'a' ? out.view_a : out.view_b, ...out.because.filter((b) => b.side === side).map((b) => b.step)];
    if (texts.some((t) => PROMISE_WORDS.some((w) => t.includes(w)))) reasons.push(`托管中的${SIDE_LABEL[side]}在讲述或步骤里替本人做了承诺`);
  }

  // 边界：不出现支付、赠送、交易、改对方车。
  for (const { field, text } of displayedTexts(out)) {
    const w = BOUNDARY_WORDS.find((x) => text.includes(x));
    if (w) reasons.push(`${field} 越界：${w}`);
  }

  // 分项许可：不许可的类型不生成，出现即越权。
  const allowed = opts.allowed ?? ['activity', 'talk'];
  for (const k of out.kind) if (!allowed.includes(k)) reasons.push(`越权：没有许可却生成了 ${k}`);
  for (const b of out.because) if (!out.kind.includes(b.type)) reasons.push(`because 的 ${b.type} 步骤不在 kind 里`);
  if (!allowed.includes('talk')) {
    // 聊天许可按内容而不按类型标签。
    if ((out.excerpt ?? []).length > 0) reasons.push('越权：没有聊天许可却带了对话节选');
    if ((out.talk_happening ?? '').trim()) reasons.push('越权：没有聊天许可却写了话题');
    for (const { field, text } of displayedTexts(out)) {
      const w = CHAT_WORDS.find((x) => text.includes(x));
      if (w) reasons.push(`越权：没有聊天许可，${field} 却写了交谈（${w}）`);
    }
  }

  // 动作列表：有 activity 就必须列出动作；activity 步骤只能引用列出的动作。
  if (out.kind.includes('activity')) {
    const acts = out.actions ?? [];
    if (acts.length === 0) reasons.push('有 activity 却没有 actions 动作列表');
    for (const b of out.because) {
      if (b.type === 'activity' && !acts.some((a) => a.side === b.side && a.action === b.step)) reasons.push(`because 的步骤“${b.step}”不在 actions 里`);
    }
  }

  // 规则对照组：只核结构化字段——动作编号与 activity 步骤必须等于锁定的结果。
  // 讲述是否偏离锁定事件，纯函数判不准，不算通过事件一致性（由盲评记“讲述偏离”）。
  if (arm.arm === 'rule') {
    const chosen = arm.event.action;
    if ((out.action ?? null) !== chosen) reasons.push(`讲述写的事（${out.action ?? '无事'}）不是规则选中的（${chosen ?? '无事'}）`);
    if (chosen === null && out.kind.includes('activity')) reasons.push('规则选了“无事”，讲述却写了一起做的事');
    const key = (b: BecauseStep) => `${b.card}|${b.side}|${b.step}`;
    const got = out.because.filter((b) => b.type === 'activity').map(key);
    const locked = arm.event.because.map(key);
    if (got.length !== locked.length || got.some((k, i) => k !== locked[i])) reasons.push('activity 步骤与规则锁定的不一致');
  }

  return reasons.length ? { ok: false, reasons } : { ok: true };
}

/**
 * 规则对照组：模型响应只含讲述与 talk，不得带动作编号或 activity 类型的 because（出现即视为试图覆盖锁定字段，拦下）；
 * 服务端把锁定的动作、步骤与 uses 合并进去，再交给 checkOutput。talk 的 because 仍由模型给出，只作探索项。
 */
export type MergeResult = { ok: true; merged: ModelOutput } | { ok: false; reasons: string[] };

export function mergeRuleResponse(response: ModelOutput, event: RuleEvent): MergeResult {
  const reasons: string[] = [];
  if (response.action !== undefined) reasons.push('模型响应带了动作编号，试图覆盖锁定字段');
  if (response.because.some((b) => b.type === 'activity')) reasons.push('模型响应带了 activity 步骤，试图覆盖锁定字段');
  if (response.happening.trim()) reasons.push('模型响应带了 activity 的 happening，试图覆盖锁定字段');
  if (response.actions !== undefined) reasons.push('模型响应带了 actions，试图覆盖锁定字段');
  if (response.kind.includes('activity')) reasons.push('模型响应的 kind 含 activity，试图覆盖锁定字段');
  if (reasons.length) return { ok: false, reasons };
  const facts = [...response.facts_used];
  for (const b of event.because) for (const u of b.uses) if (!hasFact(facts, u)) facts.push(u);
  const kind: Kind[] = event.action ? Array.from(new Set<Kind>(['activity', ...response.kind])) : response.kind.filter((k) => k !== 'activity');
  const happening = event.action ? `甲、乙：${event.name}` : '';
  const actions = event.because.map((b) => ({ side: b.side, action: b.step }));
  return { ok: true, merged: { ...response, kind, action: event.action, happening, actions, because: [...event.because, ...response.because], facts_used: facts } };
}

// ───────────────────────── 收据（纸样第四节 收据分两层） ─────────────────────────

export interface Receipt {
  visitId: string;
  /** 事实行：只由服务端事实和通过核对的 because 步骤生成。 */
  facts: string[];
  /** 主观讲述与演绎，原样保留，不作事实凭据；普通收据为空。 */
  views: { a: string; b: string } | null;
  excerpt: { speaker: string; text: string }[];
  plain: boolean;
  /** 增强收据包含的互动类型；投递前按它复核许可。 */
  kinds: Kind[];
  /** 生成时送进模型的全部可撤回事实（装备与侧帐状态）；投递前保守复核，不只看申报。 */
  inputFacts: FactRef[];
}

function presenceLabel(p: Presence) {
  return p === 'present' ? '本人在场' : '托管中';
}

function baseFacts(snap: EncounterSnapshot): string[] {
  const host: Side = snap.a.role === 'host' ? 'a' : 'b';
  return [
    `${SIDE_LABEL[host]}接待了${SIDE_LABEL[other(host)]}`,
    `甲（${presenceLabel(snap.a.presence)}），乙（${presenceLabel(snap.b.presence)}）`,
  ];
}

/** 普通收据：超预算、超时、拦截或撤权时只发它，不编故事凑数。 */
export function plainReceipt(snap: EncounterSnapshot): Receipt {
  return { visitId: snap.visitId, facts: baseFacts(snap), views: null, excerpt: [], plain: true, kinds: [], inputFacts: [] };
}

/** 核对通过才生成带讲述的收据；不过就退普通收据，不重试。 */
export function buildReceipt(snap: EncounterSnapshot, out: ModelOutput, arm: Arm, opts: CheckOptions = {}): { receipt: Receipt; check: CheckResult } {
  const check = checkOutput(snap, out, arm, opts);
  if (!check.ok) return { receipt: plainReceipt(snap), check };
  // because 为空（没有归因）只发普通收据，不硬挂卡。
  if (out.because.length === 0) return { receipt: plainReceipt(snap), check };
  const facts = baseFacts(snap);
  for (const b of out.because) {
    // 卡与角色是服务端核过的归因；步骤文字是模型写的，标“演绎”，不写成本人做的。
    facts.push(`${SIDE_LABEL[b.side]}（${presenceLabel(snap[b.side].presence)}）因${STARTER_CARDS[b.card].name} · 演绎：${b.step}`);
  }
  const excerpt = (out.excerpt ?? []).map((l) => ({
    speaker: `${SIDE_LABEL[l.side]}（${presenceLabel(l.presence)}·${l.source === 'player' ? '本人' : '演绎'}）`,
    text: l.text,
  }));
  const inputFacts = snapshotFacts(snap).filter((f) => f.subject !== 'camp' && (f.key.startsWith('gear:') || f.key === 'awning:deployed'));
  return { receipt: { visitId: snap.visitId, facts, views: { a: out.view_a, b: out.view_b }, excerpt, plain: false, kinds: [...out.kind], inputFacts }, check };
}

/**
 * 安全审核的输入：两份收据都渲染完之后、投递之前，列出所有含模型文字的展示字段
 * （讲述、节选、happening，以及事实行里模型写的 because 步骤）。
 */
export function safetyTexts(receipt: Receipt, out: ModelOutput): string[] {
  if (receipt.plain) return [];
  return [out.happening, out.talk_happening ?? '', receipt.views?.a ?? '', receipt.views?.b ?? '', ...receipt.excerpt.map((l) => l.text), ...receipt.facts];
}

/** 安全审核拦下或无法检查时，两份都只发普通收据。 */
export function applySafety(snap: EncounterSnapshot, receipt: Receipt, verdict: 'pass' | 'blocked' | 'unavailable'): Receipt {
  return verdict === 'pass' ? receipt : plainReceipt(snap);
}

/**
 * 投递前复核（安全审核结束之后，与落地绑在同一步）：
 * - 无条件：好友关系与双方接待许可，任一不满足什么都不投递（返回 null）；
 * - 增强收据另查所含类型的许可，以及展示的每条事实对收件方仍可分享（unshared 为已撤回分享的事实），缺任一项退普通收据。
 */
export function deliverable(snap: EncounterSnapshot, receipt: Receipt, g: Grants, unshared: readonly FactRef[] = []): Receipt | null {
  const now = allowedKinds(g);
  if (now.length === 0) return null;
  if (receipt.plain) return receipt;
  const kindsOk = receipt.kinds.every((k) => now.includes(k));
  const factsOk = !receipt.inputFacts.some((f) => hasFact(unshared, f));
  return kindsOk && factsOk ? receipt : plainReceipt(snap);
}

/** 来访号认领：同一来访号只有第一个处理者能认领并调模型；之后到来的不重新调用、不覆盖，等首份落地后直接读。 */
export function claimVisit(claimed: Set<string>, visitId: string): boolean {
  if (claimed.has(visitId)) return false;
  claimed.add(visitId);
  return true;
}

/** 内部审计记录：含原始输出与被丢弃内容，单独存放、权限受限，不随路书读取接口返回。保留期提案 30 天。 */
export const AUDIT_RETENTION_DAYS = 30;
export interface AuditRecord {
  visitId: string;
  arm: Arm['arm'];
  snapshot: EncounterSnapshot;
  rawOutput: ModelOutput;
  check: CheckResult;
  safety: 'pass' | 'blocked' | 'unavailable' | 'skipped';
  expiresAtMs: number;
}

export function auditRecord(snap: EncounterSnapshot, arm: Arm, rawOutput: ModelOutput, check: CheckResult, safety: AuditRecord['safety'], nowMs: number): AuditRecord {
  return { visitId: snap.visitId, arm: arm.arm, snapshot: snap, rawOutput, check, safety, expiresAtMs: nowMs + AUDIT_RETENTION_DAYS * 86_400_000 };
}
