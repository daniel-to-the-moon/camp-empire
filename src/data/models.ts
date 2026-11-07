import raw from '../../models.json';

/** 一个可选车辆变体：基础车型 + 一个公告高度。单位全部为米。 */
export interface Variant {
  id: string;
  model: string;
  lengthM: number;
  widthM: number;
  heightM: number;
  wheelbaseM: number;
  frontOverhangM: number;
  rearOverhangM: number;
  /** 仅 SH5043XLJH9DB-C 为 true（CLEANROOM_SPEC 第五节） */
  hasBrow: boolean;
  /** 顶高标签：同款最低为“低顶”、最高为“高顶”，中间只显示数值 */
  roofLabel: string;
}

export interface BaseModel {
  model: string;
  variants: Variant[];
}

interface RawModel {
  model: string;
  length_mm: number;
  width_mm: number;
  heights_mm: number[];
  wheelbase_mm: number;
  front_overhang_mm: number;
  rear_overhang_mm: number;
}

const mm = (v: number) => v / 1000;

export function roofLabel(heights: number[], h: number): string {
  if (heights.length === 1) return `${h} mm`;
  const min = Math.min(...heights);
  const max = Math.max(...heights);
  if (h === min) return `低顶 ${h} mm`;
  if (h === max) return `高顶 ${h} mm`;
  return `${h} mm`;
}

export function buildCatalog(models: RawModel[]): BaseModel[] {
  return models.map((m) => {
    if (m.wheelbase_mm + m.front_overhang_mm + m.rear_overhang_mm !== m.length_mm) {
      throw new Error(`${m.model}: 轴距 + 前悬 + 后悬 ≠ 车长，models.json 数据不一致`);
    }
    return {
      model: m.model,
      variants: m.heights_mm.map((h) => ({
        id: `${m.model}_${h}`,
        model: m.model,
        lengthM: mm(m.length_mm),
        widthM: mm(m.width_mm),
        heightM: mm(h),
        wheelbaseM: mm(m.wheelbase_mm),
        frontOverhangM: mm(m.front_overhang_mm),
        rearOverhangM: mm(m.rear_overhang_mm),
        hasBrow: m.model === 'SH5043XLJH9DB-C',
        roofLabel: roofLabel(m.heights_mm, h),
      })),
    };
  });
}

export const CATALOG: BaseModel[] = buildCatalog(raw.base_models as RawModel[]);
export const ALL_VARIANTS: Variant[] = CATALOG.flatMap((m) => m.variants);

export function findVariant(id: string): Variant | undefined {
  return ALL_VARIANTS.find((v) => v.id === id);
}

export const volumeM3 = (v: Variant) => v.lengthM * v.widthM * v.heightM;
