# 资产来源台账

依 [CHARTER.md](../CHARTER.md) 第三节第 1 条：每件第三方或生成资产入库前，在此记下来源、许可证原文、核实日期。「已核实」只指下表引用的页面文字；页面没写的事项一律记为未说明。

## 已核实的候选来源（2026-11-26，Claude 读取官方页面；末三行于 2026-11-28 由音效师追加）

| 来源 | 许可证 | 页面原文（摘录） | 状态 |
|---|---|---|---|
| [Kenney Nature Kit](https://kenney.nl/assets/nature-kit) | CC0 | 「License Creative Commons CC0」；330 件；v1.0（2020-04-29） | 选用（起步组合） |
| [Quaternius Universal Animation Library](https://quaternius.com/packs/universalanimationlibrary.html) · [OGA 页](https://opengameart.org/content/universal-animation-library) | CC0 | 「Free to use in personal, educational and commercial projects. (CC0 License)」；格式 FBX/GLB/Blend；Standard 版 45 个动画，Source 版 120+（付费）；「universal humanoid rig … ready for retargeting」 | 选用（起步组合）；逐个动画名未列出，下载后核对 |
| [Kenney City Kit (Roads)](https://kenney.nl/assets/city-kit-roads) | CC0 | 「License Creative Commons CC0」；70 个文件；v2.0（2025-03-13） | 许可可用，画风不选 |
| [Kenney Survival Kit](https://www.kenney.nl/assets/survival-kit) | CC0 | 「License Creative Commons CC0」；80 个文件；含动画 | 许可可用，起步不需要 |
| [Quaternius Ultimate Stylized Nature](https://quaternius.com/packs/ultimatestylizednature.html) | CC0 | 「free to use in personal and commercial projects」；63 个模型；带无缝贴图和法线贴图 | 许可可用，因贴图显存与画风不选 |
| [Quaternius Universal Base Characters](https://quaternius.com/packs/universalbasecharacters.html) | CC0 | 「Average 13k triangle count」；「Compatible with the Universal Animation Library」 | 许可可用，面数过高不选 |
| [Mixamo](https://helpx.adobe.com/en/creative-cloud/faq/mixamo-faq.html)（FAQ 更新于 2021-09-14） | Adobe 条款（非 CC） | 「You can use both characters and animations royalty free for personal, commercial, and non-profit projects」；需 Adobe ID；不对 Enterprise/Federated ID 及中国国家代码账号开放；未说明原始文件能否再分发 | 备选，不进起步组合 |
| [Kenney Interface Sounds](https://kenney.nl/assets/interface-sounds) | CC0 | 页面写「License Creative Commons CC0」 | 选用（界面轻点、收取停车费成功）；2026-11-28 音效师核实 |
| [Freesound](https://freesound.org/) 上标记 CC0 的单条录音 | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | 各条声音页均标 CC0。原文件下载需登录；本次入库为站点提供的官方 HQ 预览 MP3（启动、会车两条再按维护者要求裁切） | 选用已验收的 6 条（见已入库表）；未登录故原文件待补 |
| [Mixkit Sound Effects Free License](https://mixkit.co/license/modal/sfxFree/)（2026-11-28 音效师读取） | Mixkit SFX Free License，并受 [User Terms](https://mixkit.co/terms/) 约束 | 许可页写：可用于商业与非商业项目（含 video games）；可下载、复制、修改、分发并公开播放；「You can’t redistribute the Item on its own, as stock, in a tool or template, or with source files. You’re also not allowed to claim them as your own or register them on any rights management service. There are some important limits to these rights, described in our User Terms.」User Terms 已读到的限制包括：违约可终止授权并要求停止使用；部分素材可能含第三方商标等成分，是否另需许可由使用者自行判断并取得。User Terms 未做逐条全文归档，**待核实**。 | 选用 Achievement bell 一条。不得把该文件单独再分发为素材库。 |

CC0 不要求署名；仍建议在游戏「致谢」里写 Kenney、Quaternius，以及本批 Freesound 作者（GammaGool、Nox_Sound、AndrewAlexander、KikeVilaplana、Qvantor、MieckevanHoek）。

## 已入库资产

核实日期：2026-11-28（音效师读取官方页面 / 试听包文件）。「已核实」只指下表引用的页面文字。下一版本接入规格（本批不含播放实现）：[docs/AUDIO_M1_INTEGRATION_TODO.md](../docs/AUDIO_M1_INTEGRATION_TODO.md)。

| 文件路径 | 触发 / 用途 | 来源包与版本 | 许可证 | 改动说明 | 时长 / 体积 / SHA256 | 风险与备注 | 入库 PR |
|---|---|---|---|---|---|---|---|
| `assets/audio/sfx-amb-day-gammagool-slovenian-forest.mp3` | 白天营地环境底（循环） | GammaGool / Birds in the Slovenian Forest，[Freesound 850505](https://freesound.org/people/GammaGool/sounds/850505/)，2026-11-28 取官方 HQ 预览 MP3 | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | 未裁切。维护者 2026-11-28 试听指定。 | 约 63.53 s，1.4 MB，`cec0999fe4d153388f87cfd476cc24f0533673130fc2812ff3d7143e7e6d275d` | 听感可能偏鸟鸣。Freesound 原文件（多为 WAV/FLAC）需登录才能下，本次用官方 HQ 预览，待有账号后替换并更新哈希。 | PR_PLACEHOLDER |
| `assets/audio/sfx-amb-night-nox-cricket-calm.mp3` | 夜晚环境底（循环） | Nox_Sound / Night Cricket Calm Loop，[Freesound 637083](https://freesound.org/people/Nox_Sound/sounds/637083/)，官方 HQ 预览 MP3 | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | 未裁切。维护者 2026-11-28 试听指定（清单首推）。 | 约 59.83 s，1.4 MB，`4ee4af53ef2d1c3315eb3adf4271404779e76d259b46014b62a7a0951849f5b0` | 同上，预览待替换为原文件。 | PR_PLACEHOLDER |
| `assets/audio/sfx-veh-idle-andrewalexander-loop.mp3` | 行驶中 / 怠速循环 | AndrewAlexander / car_idle_loop，[Freesound 369053](https://freesound.org/people/AndrewAlexander/sounds/369053/)，官方 HQ 预览 MP3 | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | 未裁切。维护者 2026-11-28 试听指定。 | 约 15.18 s，333 KB，`0f6efe6683afc87a16555d01a5034104b4d817a2a06e9cbb8caa7e00818b7ede` | **商标风险（已告知，维护者仍选定）**：作者其它车辆录音曾涉及 Honda 实拍可能，本条是否同属该车型未在页面写明，待核实。预览待替换为原文件。 | PR_PLACEHOLDER |
| `assets/audio/sfx-veh-start-kikevilaplana-gravel.mp3` | 车辆启动（一次性） | KikeVilaplana / Car Engine Start Gravel Idle，[Freesound 510828](https://freesound.org/people/KikeVilaplana/sounds/510828/)，官方 HQ 预览 MP3 再裁切 | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | 源条约 11.69 s（启动+怠速）；按维护者要求只保留前半段作启动，ffmpeg 裁至约 5.88 s 并重编码 MP3。后半段怠速不入库。 | 约 5.88 s，122 KB，`14acdab85333b80b08a3999806c03dc442eb9c50836ebb80f253f8f2ccc3eea8` | 砂石表层可能偏噪。预览裁切，待原文件后再按「前半段」重裁并更新哈希。 | PR_PLACEHOLDER |
| `assets/audio/sfx-rwd-purchase-mixkit-achievement-bell.mp3` | 支付 / 购买成功（一次性） | Mixkit Achievement bell，目录 [mixkit.co/free-sound-effects/bell/](https://mixkit.co/free-sound-effects/bell/)，官方预览 MP3 | [Mixkit Sound Effects Free License](https://mixkit.co/license/modal/sfxFree/)，并受 [User Terms](https://mixkit.co/terms/) 约束 | 未裁切。维护者 2026-11-28 试听指定。 | 约 2.43 s，61 KB，`f9ad8bc90064e3873756900265d4a36f48014214bd0a1a6c4e61317a6eb7473e` | 许可要点见上方「Mixkit」来源行。User Terms 2026-11-28 已读页面正文，但未做逐条全文归档，完整条款仍待核实。 | PR_PLACEHOLDER |
| `assets/audio/sfx-ui-click-kenney-select-001.ogg` | 界面轻点（一次性） | [Kenney Interface Sounds](https://kenney.nl/assets/interface-sounds)，`select_001.ogg`，官方原文件 | [CC0](https://creativecommons.org/publicdomain/zero/1.0/)（页面写 License Creative Commons CC0） | 未裁切。维护者 2026-11-28 试听指定。 | 约 0.04 s，5.4 KB，`aec0c31ea934a35936ae0d2ab8fac8123c93aa5647f935853a58dbaf90278b7a` | 极短。CC0 不要求署名，致谢建议仍写 Kenney。 | PR_PLACEHOLDER |
| `assets/audio/sfx-rwd-gift-qvantor-modal-chime.mp3` | 每日礼物到账（一次性） | Qvantor / UI Modal Open Chime，[Freesound 878249](https://freesound.org/people/Qvantor/sounds/878249/)，官方 HQ 预览 MP3 | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | 未裁切。维护者 2026-11-28 试听指定。 | 约 1.03 s，25 KB，`c77cc5b681fa5ce2dbc5eb4c56294aeec2e039b1deef101c8867a11bb9b58d11` | 预览待替换为原文件。 | PR_PLACEHOLDER |
| `assets/audio/sfx-veh-pass-mieckevanhoek-first5s.mp3` | 会车（一次性） | MieckevanHoek / Car Stop，[Freesound 765141](https://freesound.org/people/MieckevanHoek/sounds/765141/)，官方 HQ 预览 MP3 再裁切 | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | 源条约 8.30 s；按维护者要求只保留前 5 秒，ffmpeg 裁至约 5.04 s 并重编码 MP3。 | 约 5.04 s，108 KB，`30e19c0830268a45bb8d6a2532411f07f0d16e690b160603f607112d2e3b6157` | 作者页描述为 “Car being turned off” / Car Stop。维护者将其指定为「会车」，**不要当作泊入或熄火音**。预览裁切，待原文件后再按前 5 秒重裁。此条为验收中新增，不在 issue #36 原首批列表。 | PR_PLACEHOLDER |
| `assets/audio/sfx-rwd-collect-kenney-confirmation-002.ogg` | 收取停车费成功（一次性） | [Kenney Interface Sounds](https://kenney.nl/assets/interface-sounds)，`confirmation_002.ogg`，官方原文件 | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) | 未裁切。维护者 2026-11-28 试听指定。 | 约 0.54 s，14 KB，`33b17a9a9a2397c62b285c52c33a907fdffb476909c99e42dde603f6a7a8b12c` | 致谢建议写 Kenney。 | PR_PLACEHOLDER |

## 参考图（不是资产）

| 文件 | 用途 | 来源 |
|---|---|---|
| [docs/visual/character-reference.png](../docs/visual/character-reference.png) | 人物造型参照，缩至 1200×600 | 用户 2026-11-26 提供；**GPT Image 生成**（用户 2026-11-26 确认）。生成渠道：**OpenAI API**（用户 2026-11-27 确认），适用 OpenAI Services Agreement，见下节。生成者使用服务时的居住地：待用户说明（决定合同方与适用法律）。生成输入（提示词或参考图）：待用户说明（须确认不含 MXGARAGE 旧 GLB、旧 viewer 截图或其渲染图，CHARTER 第三节第 1 条）。条款见下节。只作造型参照，不作贴图、不作 AI 生成输入、不入游戏资源。 |

### GPT Image 条款核实（2026-11-26，Claude 读取官方页面）

来源：[OpenAI Terms of Use](https://openai.com/policies/row-terms-of-use/)（「Published / Effective: January 1, 2026」），适用于「ChatGPT, DALL·E, and OpenAI's other services for individuals」。

- 归属：「you (a) retain your ownership rights in Input and (b) own the Output.」「We hereby assign to you all our right, title, and interest, if any, in and to Output.」（前提：「As between you and OpenAI, and to the extent permitted by applicable law」）
- 商用：页面未单独说明。
- 不唯一：「output may not be unique and other users may receive similar output from our Services.」
- 相关限制：不得「Represent that Output was human-generated when it was not」；不得「Use Output to develop models that compete with OpenAI」；不得侵犯他人权利；另须遵守 Usage Policies 与 Sharing & Publication Policy（**未读，待核实**）。
- 本节摘录的个人服务条款**不适用于本图**（本图经 API 生成，见下节）；保留作对照。

### OpenAI Services Agreement 核实（2026-11-27，Claude 读取官方页面）

来源：[OpenAI Services Agreement](https://openai.com/policies/services-agreement/)（「Updated: December 1, 2025」「Effective: January 1, 2026」）。适用范围：「This OpenAI Services Agreement only applies to use of OpenAI's APIs, ChatGPT Enterprise, ChatGPT Business, … and other services for customers who are businesses and developers」。本图经 API 生成，适用本协议。旧版 [Business Terms](https://openai.com/policies/business-terms/) 页面仍可访问但无生效日期，不作依据。

- 归属（4.1）：「Customer: (a) retains all ownership rights in Input; and (b) owns all Output. OpenAI hereby assigns to Customer all OpenAI's right, title, and interest, if any, in and to Output.」（前提：「As between Customer and OpenAI, to the extent permitted by applicable law」）
- 责任（4.3）：「Customer is solely responsible for all use of the Outputs and for evaluating the accuracy and appropriateness of Output for Customer's use case.」
- 不唯一（4.4）：「Output may not be unique, and other users may receive similar content from OpenAI's services.」
- 相关限制（3.3(e)）：除 Permitted Exception 外，不得「use Output to develop artificial intelligence models that compete with OpenAI's products and services」。是否须标明 AI 生成：本次读取的部分未见。Usage Policies 与 Sharing & Publication Policy **未读，待核实**。
- 商用：页面未单独说明。
- 合同方与适用法律（16.3、16.5）：本次只取得页面摘要、未取得原文，**待核实**。摘要称 EEA 或瑞士客户的合同方为 OpenAI Ireland Ltd.、其余为 OpenAI OpCo, LLC；EEA、瑞士、英国适用爱尔兰法律，其余适用加州法律。

对本图的适用性：**待核实**。渠道已确认为 API，适用 Services Agreement；仍缺生成者居住地、生成输入是否含 MXGARAGE 素材两项，Usage Policies 与 Sharing & Publication Policy 也未读。在补齐前沿用上表限制：只作造型参照，不作贴图、不作 AI 生成输入、不入游戏资源。
