/**
 * 露营卡片的生成 → 预览 → 下载 / 复制流程（issue #30）。只在玩家点按钮时运行，不自动弹出、不接分享渠道、无分享奖励。
 * DOM 与浏览器能力以最小接口注入（main.ts 传真实对象），tests/card.test.ts 用假对象验证行为。
 */
import { copyMessage, copyPng, type ClipboardEnv } from '../shared/card';

export interface CardImage {
  toBlob(cb: (b: Blob | null) => void, type: string): void;
}

export interface CardPreviewUi {
  /** 预览框（#camp-card） */
  box: { hidden: boolean };
  /** 预览图（#camp-card-img） */
  img: { src: string };
}

export interface CardFlowEnv {
  ui: CardPreviewUi;
  /** 生成卡片画布与文件名（取数 + 截图 + 排版） */
  make(): { canvas: CardImage; name: string };
  createObjectURL(b: Blob): string;
  revokeObjectURL(url: string): void;
  /** 建一个 <a> 并挂到文档上；remove 时摘下 */
  createAnchor(): { href: string; download: string; click(): void; remove(): void };
  clipboard(): ClipboardEnv;
  toast(msg: string): void;
  log?(e: unknown): void;
}

export interface ShownCard {
  blob: Blob;
  url: string;
  name: string;
}

export const CARD_FAIL_MSG = '生成卡片失败';

export function createCardFlow(env: CardFlowEnv) {
  let shown: ShownCard | null = null;
  return {
    get shown() {
      return shown;
    },
    /** 生成并显示预览；失败时提示，预览框保持原样，已有卡片不受影响 */
    async generate(): Promise<boolean> {
      try {
        const { canvas, name } = env.make();
        const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
        if (!blob) {
          env.toast(CARD_FAIL_MSG);
          return false;
        }
        if (shown) env.revokeObjectURL(shown.url);
        shown = { blob, url: env.createObjectURL(blob), name };
        env.ui.img.src = shown.url;
        env.ui.box.hidden = false;
        return true;
      } catch (e) {
        env.log?.(e);
        env.toast(CARD_FAIL_MSG);
        return false;
      }
    },
    /** 下载当前预览的 PNG */
    download(): boolean {
      if (!shown) return false;
      const a = env.createAnchor();
      a.href = shown.url;
      a.download = shown.name;
      a.click();
      a.remove();
      return true;
    },
    /** 复制当前预览的 PNG；结果（含不支持 / 被拒时的下载引导）用提示告知。返回是否真的复制成功（统计用） */
    async copy(): Promise<boolean> {
      if (!shown) return false;
      const r = await copyPng(shown.blob, env.clipboard());
      env.toast(copyMessage(r));
      return r === 'copied';
    },
    close() {
      env.ui.box.hidden = true;
    },
  };
}
