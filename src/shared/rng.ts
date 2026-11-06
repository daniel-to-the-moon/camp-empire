/**
 * 确定性随机：同一 (种子, 键) 永远得到同一个数。
 * 用途：离线回放结果不因刷新、重放、多端同时请求而改变（防止反复读档重掷）。
 */

/** 字符串 → 32 位哈希（cyrb53 的 32 位截断） */
export function hash32(s: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

/** [0, 1) 均匀分布 */
export function uniform(seed: number, key: string): number {
  // mulberry32 一步
  let a = (hash32(`${seed}|${key}`) + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  a = (t ^ (t >>> 14)) >>> 0;
  return a / 4294967296;
}

/** 按离散分布抽样，返回下标 */
export function pickWeighted(u: number, ps: readonly number[]): number {
  let acc = 0;
  for (let i = 0; i < ps.length; i++) {
    acc += ps[i];
    if (u < acc) return i;
  }
  return ps.length - 1;
}
