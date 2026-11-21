# camp-empire · 房车露营游戏

一款网页房车露营游戏：选车 → 做任务 → 升级露营装备 → 经营营地车位社交 → 分享炫耀；远期长成商家虚拟 vankit 品牌投放 + 玩家交易的商业帝国雏形。

## 分工（用户 2026-11-03 第二次拍板，详见 `CHARTER.md` 第一节）

- **GPT Image**：低多边形场景图
- **Tripo**：3D 资产
- **Claude（Opus 5.5）**：写代码
- **GPT**：修复 Bug
- **其他需要讨论的事项**：几个 agent 在 discussion issue 里一起讨论，用户拍板
- **用户**：最终上线唯一决定人（合并、发布、收费开关一律用户拍板）

## 文档

- `CHARTER.md`：仓库章程（分工、讨论证据规则、硬边界、工作包）
- `MODEL_PACKAGE.md`：车模型供给包（尺寸、锚点、性能预算、许可证闸门）
- `models.json`：9 款基础车型、25 个高度变体的公开尺寸数据
- `GDD-v0.1-讨论稿.md`：游戏策划案讨论稿（已核实与待核实严格区分）
- `docs/ECONOMY_M1.md`：M1 原型数值推演表（提案，待讨论）
- `docs/SWEPT_PATH.md`：转弯半径与扫掠包络（游戏手感参数，非工程标准）
- `docs/BUSINESS_PLAN.md`：商业目标与开发任务拆解（提案，待用户拍板）
- `docs/ANALYTICS.md`：T1 匿名统计（记什么、不记什么、如何开启）

## M1 原型（讨论用，未经批准上线）

在一块有边界的营地里：选车 → 开车兜圈 / 一键泊回家位 → NPC 露营者自己来停你的车位、离开时自动付费 → 买侧边帐。
车辆外观是按公告三围生成的占位几何，场景是占位色块。

```bash
npm install
npm run dev            # 本地开发服务器；地址加 ?dev 显示时间快进面板
npm test               # 单元测试：账本、NPC 回放、运动学、全部车型 × 车位的进出路径、占位几何 bbox
npm run build          # 类型检查 + 生产构建
npm run economy:table  # 重算 docs/ECONOMY_M1.md 的数字
npm run swept:table    # 重算 docs/SWEPT_PATH.md 的数字
```

操作：<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 或方向键驾驶，空格刹车，<kbd>P</kbd> 自动泊回家位，<kbd>O</kbd> 从家位开出，按住 <kbd>Shift</kbd>（或点底栏“加速挡”）加速；视图 <kbd>1</kbd> 俯瞰 / <kbd>2</kbd> 跟随 / <kbd>3</kbd> 环绕 / <kbd>4</kbd> 引擎盖，<kbd>V</kbd> 轮换，<kbd>C</kbd> 俯瞰 ↔ 跟随；环绕视图下拖拽画面旋转、滚轮或双指缩放。规则与数值见 `docs/DRIVING_VIEW.md`。

目录：
- `src/shared/`：玩法纯逻辑（账本、NPC 停车、运动学、Dubins 路径、营地布局、泊车规划、存档状态），不依赖渲染，可原样迁到服务端
- `src/geometry/`：占位车辆几何与升级件锚点（对齐口径见 `MODEL_PACKAGE.md`）
- `src/client/`：Three.js 场景与界面

## 两条硬边界（先说清楚）

1. **模型许可证**：25 款 GLB 为半衍生资产，仅限 MXGARAGE 应用内部使用，不得直接搬入本仓库；立项阶段用按公开三围参数化的占位几何开发，正式模型须 clean-room 重写或取得许可后才可上线。
2. **讨论证据规则**：任何观点须过定性 + 定量 + 实时 + 常识四维，缺一维即标待核实，不得当结论。

## 协作

讨论在 discussion 类 issue 里进行（仅讨论、非 claim、非决定、非评审）；一个 PR 一名执行者；上线前须用户签字。
