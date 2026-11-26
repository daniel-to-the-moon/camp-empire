// gates.mjs 的纯函数部分（scripts/devloop/perf-gate.test.mjs 覆盖）。

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
};

/** 分帧记录 [{calls, tris, ms}] → 统计。第一帧 ms=0（没有上一帧），不计入帧时间 */
export function summarize(frames) {
  const calls = frames.map((f) => f.calls);
  const tris = frames.map((f) => f.tris);
  const ms = frames.map((f) => f.ms).filter((x) => x > 0);
  return {
    frames: frames.length,
    callsMedian: median(calls),
    callsMax: calls.length ? Math.max(...calls) : 0,
    trisMedian: median(tris),
    trisMax: tris.length ? Math.max(...tris) : 0,
    msMedian: Math.round(median(ms) * 10) / 10,
  };
}

/** 供 PR 所链接的 CI 运行摘要使用，与 perf.json 同源；缺采样不能写成 0 ms。 */
export function perfTable(scenes) {
  return [
    '### E2E 整场实测（SwiftShader；帧时间仅供同环境比较）', '',
    '| 场景 | 采样帧 | draw call 中位 / 最大 | 三角形中位 | 帧时间中位 (ms) |', '|---|---:|---:|---:|---:|',
    ...['camp', 'driving'].map((name) => {
      const s = scenes[name];
      return s?.frames ? `| ${name} | ${s.frames} | ${s.callsMedian} / ${s.callsMax} | ${s.trisMedian} | ${s.msMedian || '—'} |`
        : `| ${name} | 未采到 | — | — | — |`;
    }), '',
  ].join('\n');
}

/**
 * 按预算判定。budgets.scenes[name] = { callsMedian?, callsMax?, trisMedian?, trisMax?, minFrames? }
 * 预算里列出的场景必须采到；采到的帧数不足 minFrames（默认 30）也算失败（防止“没渲染所以 0 draw call”蒙混过关）。
 */
export function checkBudgets(scenes, budgets) {
  const out = [];
  for (const [name, b] of Object.entries(budgets.scenes ?? {})) {
    const s = scenes[name];
    if (!s) { out.push(`场景 ${name} 没有采到数据`); continue; }
    const minFrames = b.minFrames ?? 30;
    if (s.frames < minFrames) out.push(`场景 ${name} 只采到 ${s.frames} 帧（至少 ${minFrames}）`);
    for (const k of ['callsMedian', 'callsMax', 'trisMedian', 'trisMax']) {
      if (b[k] != null && s[k] > b[k]) out.push(`场景 ${name} 的 ${k} = ${s[k]}，超出预算 ${b[k]}`);
    }
    if (s.callsMedian === 0) out.push(`场景 ${name} 没有任何 draw call，疑似没有渲染`);
  }
  return out;
}
