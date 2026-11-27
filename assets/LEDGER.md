# 资产来源台账

依 [CHARTER.md](../CHARTER.md) 第三节第 1 条：每件第三方或生成资产入库前，在此记下来源、许可证原文、核实日期。「已核实」只指下表引用的页面文字；页面没写的事项一律记为未说明。

## 已核实的候选来源（2026-11-26，Claude 读取官方页面）

| 来源 | 许可证 | 页面原文（摘录） | 状态 |
|---|---|---|---|
| [Kenney Nature Kit](https://kenney.nl/assets/nature-kit) | CC0 | 「License Creative Commons CC0」；330 件；v1.0（2020-04-29） | 选用（起步组合） |
| [Quaternius Universal Animation Library](https://quaternius.com/packs/universalanimationlibrary.html) · [OGA 页](https://opengameart.org/content/universal-animation-library) | CC0 | 「Free to use in personal, educational and commercial projects. (CC0 License)」；格式 FBX/GLB/Blend；Standard 版 45 个动画，Source 版 120+（付费）；「universal humanoid rig … ready for retargeting」 | 选用（起步组合）；逐个动画名未列出，下载后核对 |
| [Kenney City Kit (Roads)](https://kenney.nl/assets/city-kit-roads) | CC0 | 「License Creative Commons CC0」；70 个文件；v2.0（2025-03-13） | 许可可用，画风不选 |
| [Kenney Survival Kit](https://www.kenney.nl/assets/survival-kit) | CC0 | 「License Creative Commons CC0」；80 个文件；含动画 | 许可可用，起步不需要 |
| [Quaternius Ultimate Stylized Nature](https://quaternius.com/packs/ultimatestylizednature.html) | CC0 | 「free to use in personal and commercial projects」；63 个模型；带无缝贴图和法线贴图 | 许可可用，因贴图显存与画风不选 |
| [Quaternius Universal Base Characters](https://quaternius.com/packs/universalbasecharacters.html) | CC0 | 「Average 13k triangle count」；「Compatible with the Universal Animation Library」 | 许可可用，面数过高不选 |
| [Mixamo](https://helpx.adobe.com/en/creative-cloud/faq/mixamo-faq.html)（FAQ 更新于 2021-09-14） | Adobe 条款（非 CC） | 「You can use both characters and animations royalty free for personal, commercial, and non-profit projects」；需 Adobe ID；不对 Enterprise/Federated ID 及中国国家代码账号开放；未说明原始文件能否再分发 | 备选，不进起步组合 |

CC0 不要求署名；仍建议在游戏「致谢」里写 Kenney、Quaternius。

## 已入库资产

（暂无。入库时逐件补一行：文件路径、来源包与版本、改动说明、入库 PR。）

## 参考图（不是资产）

| 文件 | 用途 | 来源 |
|---|---|---|
| [docs/visual/character-reference.png](../docs/visual/character-reference.png) | 人物造型参照，缩至 1200×600 | 用户 2026-11-26 提供；**GPT Image 生成**（用户 2026-11-26 确认）。账号套餐 / 走 ChatGPT 还是 API / 适用地区：待用户说明。生成输入（提示词或参考图）：待用户说明（须确认不含 MXGARAGE 旧 GLB、旧 viewer 截图或其渲染图，CHARTER 第三节第 1 条）。条款见下节。只作造型参照，不作贴图、不作 AI 生成输入、不入游戏资源。 |

### GPT Image 条款核实（2026-11-26，Claude 读取官方页面）

来源：[OpenAI Terms of Use](https://openai.com/policies/row-terms-of-use/)（「Published / Effective: January 1, 2026」），适用于「ChatGPT, DALL·E, and OpenAI's other services for individuals」。

- 归属：「you (a) retain your ownership rights in Input and (b) own the Output.」「We hereby assign to you all our right, title, and interest, if any, in and to Output.」（前提：「As between you and OpenAI, and to the extent permitted by applicable law」）
- 商用：条款没有单独写商用许可或禁止；可依据的只有上面的产出归属转让。
- 不唯一：「output may not be unique and other users may receive similar output from our Services.」
- 相关限制：不得「Represent that Output was human-generated when it was not」；不得「Use Output to develop models that compete with OpenAI」；不得侵犯他人权利；另须遵守 Usage Policies 与 Sharing & Publication Policy（**未读，待核实**）。
- 若是通过 API 或企业账号生成，适用的是 [Business Terms](https://openai.com/policies/business-terms/)（**未读，待核实**）；欧盟 / 英国 / 瑞士用户适用单独的 EU 条款。

对本图的适用性：**待核实**。上面摘录的是面向个人的服务条款；本图通过哪项服务、哪个账号套餐、在哪个地区生成尚未确认，Usage Policies 与 Sharing & Publication Policy 也未读，因此暂不对本图的授权下结论。在核实前沿用上表限制：只作造型参照，不作贴图、不作 AI 生成输入、不入游戏资源。用户确认生成渠道、套餐和地区并核对相应条款后，再在此补结论。
