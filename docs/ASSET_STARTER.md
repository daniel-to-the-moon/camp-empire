# 最小起步素材组合（提案，待用户确认）

制定：2026-11-26，Claude（应 morita 要求，按 [STYLE.md](visual/STYLE.md)、[STYLE_DIRECTION.md](visual/STYLE_DIRECTION.md) 方向 B、[GAME_PILLARS.md](GAME_PILLARS.md) 选定）。
许可证核实记录见 [assets/LEDGER.md](../assets/LEDGER.md)。本文件只定「用什么」；不引入任何资产文件，入库由下方各工作项的认领方完成。

## 一句话结论

**场景只用 Kenney Nature Kit 一套（CC0、无贴图）；人物自建低面数 Q 版网格，绑到 Quaternius Universal Animation Library 的通用人形骨架上播它的 CC0 动画；湖水用着色器，不用模型。** 全部留在现有 Three.js 0.187 上，用自带的 `GLTFLoader` + `AnimationMixer`，不换引擎、不加运行时依赖。

| 环节 | 选定 | 不选及原因 |
|---|---|---|
| 场景（树、石、草丛、营火、帐篷、栅栏、小路） | **Kenney Nature Kit**（CC0，330 件，纯色材质，无贴图） | Quaternius 自然套装：带无缝贴图和法线贴图，显存更大，且与 Kenney 两种画风混用会打架。Kenney City Kit Roads：城市柏油路 + 车道线，和现有暖棕土路不符；现有程序化道路保留。 |
| 人物网格 | **自建**：按 [角色参考图](visual/character-reference.png) 做低面数 Q 版（目标每人 ≤3,000 三角形，单网格单材质，顶点色） | Quaternius Universal Base Characters：平均 13k 三角形，营地 4 人就吃掉整场 30k 预算的大半；比例也偏写实。Mixamo 角色：同理过重。 |
| 骨架与动画 | **Quaternius Universal Animation Library**（CC0，免费 Standard 版 45 个动画，GLB，人形通用骨架，可关根运动） | Mixamo：Adobe FAQ 写明 **中国国家代码账号不可用**，且需 Adobe ID；条款未说明原始动画文件能否随网页公开分发（网页游戏的 GLB 会被直接下载）。保留为备选，不进起步组合。 |
| 编辑器 | 不用。场景摆放继续写在代码里 | Needle Engine / PlayCanvas：引入新工具链或迁移引擎，起步阶段收益小于成本。 |
| 湖水 | **着色器**：单个平面 + 自写 `ShaderMaterial`（岸线渐变 + 低频切面波纹 + 暖色天光高光），无贴图、无反射渲染目标 | `three/examples` 的 `Water`：需要法线贴图，并且每帧多渲染一次镜像场景，draw call 与显存都翻倍。湖面模型：做不出随时间变化的水光。 |

## 为什么符合方向 B 的「Q 软」画风

- Kenney Nature Kit 是切面清楚的低多边形、纯色材质，和 STYLE.md 第 2 节一致。原色偏冷绿，**入库时须统一改成 STYLE.md 第 1 节暖色板**（麦色地、暖棕路、粉云；树冠压低饱和），CC0 允许改。改色靠替换材质颜色或烘成顶点色，不加贴图。
- 人物参考图（米色宽松卫衣、绿条纹短裤、白鞋、长卷发、棒球帽）配色暖、无纯黑，与 STYLE.md 第 1 节一致。参考图是带笔触的 2D 绘画；进游戏要转成低多边形：头身比约 1:3.5，卷发做成 3～5 块大发片，条纹、鞋底、帽檐用顶点色分区，不做布料褶皱几何。
- 结构仍要交代清楚（STYLE.md 第 2 节）：人站在地面上，不穿车身；动作时手不穿模。

## 内存与性能口径

- 现行整场闸门（[budgets.json](../scripts/e2e/budgets.json)）：营地 draw call 中位 ≤130，三角形中位 ≤30,000；main 基线营地 97 call / 5,374 三角形。
- 起步组合目标（提案，待 CI 实测）：Kenney 只挑 **≤20 种部件**，同款用 `InstancedMesh`，合计新增 ≤12,000 三角形、≤20 draw call；人物同屏 ≤4 个 × ≤3,000 三角形，共用一副骨架和一份动画剪辑；湖 1 个 draw call。
- 无贴图 → 显存基本只有顶点缓冲。动画只打包实际用到的剪辑（见下），其余不入库。
- 模型统一导出 GLB，可选 meshopt 压缩（Three.js 自带 `MeshoptDecoder`，无新依赖）。

## 人物要用到的动作（来自 GAME_PILLARS 代客停靠）

待机、走路、**招手、指位、倒车手势、比 OK、挥手送别**。Universal Animation Library 页面只写了「locomotion、emotes」等类别，**没有逐个列出动画名**：待机、走路基本确定有；招手等五个引导手势在免费 Standard 版里有没有，须下载后核对。缺的有两条路：自己在 Blender 里按同一骨架补关键帧（推荐，手势都短），或购买 Source 版（120+ 动画）。

## 待拍板与已拍板

1. **帽子上的 MXGARAGE 字样**：用户 2026-11-26 已定**不保留**，做无字素帽，不加任何品牌标志（与 STYLE.md 第 2 节一致）。
2. **参考图来源**：用户已确认是 AI 生成（2026-11-26）；还需在 LEDGER 记下生成工具和账号套餐的商用条款（CHARTER 第三节第 1 条）。补齐前只作造型参照，不作贴图或生成输入。

## 工作项（各自开 issue，供角色认领）

1. 场景：GLB 加载管线 + Kenney Nature Kit 子集入库、暖色改色、实例化。
2. 湖水着色器。
3. 人物：低面数 Q 版网格（主设出造型）+ 绑骨 + 动画剪辑接入。
