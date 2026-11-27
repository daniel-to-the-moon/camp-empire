/**
 * 车型图鉴面板（#31）的 HTML。数据来自 shared/dex.ts dexView（纯函数，tests/dex.test.ts 覆盖）。
 */
import { DEX_UNLOCK_HINT, type DexSlotView, type DexView } from '../shared/dex';
import { closeButton } from './icons';

function slotHtml(s: DexSlotView): string {
  if (!s.lit) {
    return `<li class="dex-slot off"><span class="sil" aria-hidden="true">?</span><b>${s.roofLabel}</b><span class="sub">${DEX_UNLOCK_HINT}</span></li>`;
  }
  const first = s.firstVisit === null ? '还没有露营者开它来过' : s.firstVisit === 'unknown' ? '首次到访：升级前，日期未记录' : `首次到访 ${s.firstVisit}`;
  return `<li class="dex-slot on"><b>${s.model}</b><span>${s.roofLabel}（高 ${s.heightMm} mm）</span>
    <span class="sub">${first} · 累计到访 ${s.visits} 次${s.driven ? ' · 你开过' : ''}</span></li>`;
}

export function dexHtml(v: DexView): string {
  return `
    ${closeButton('dexClose')}
    <div class="row"><h2>车型图鉴</h2><span class="dex-count">已点亮 ${v.lit} / ${v.total}</span></div>
    <p class="fine">规则全部明码：露营者开进营地（入场即算，爱心车位也算）就点亮他的车型并累计次数；你在车库里换上过的车型也点亮。
      每位露营者的车型从 ${v.total} 款中等概率选取（各 1/${v.total}）。没有抽取、没有付费。</p>
    <div class="dex-groups">${v.groups
      .map((g) => `<section><h3>${g.model}<span>${g.lit} / ${g.slots.length}</span></h3><ul>${g.slots.map(slotHtml).join('')}</ul></section>`)
      .join('')}</div>`;
}
