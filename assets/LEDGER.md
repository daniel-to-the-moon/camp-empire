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
| [docs/visual/character-reference.png](../docs/visual/character-reference.png) | 人物造型参照，缩至 1200×600 | 用户 2026-11-26 提供；**GPT Image 生成**（用户 2026-11-26 确认）。生成渠道：**OpenAI API**（用户 2026-11-27 确认），适用 OpenAI Services Agreement，见下节。生成者使用服务时的居住地：**上海**（用户 2026-11-27 确认），不在 EEA 或瑞士。生成输入：**不含 MXGARAGE 素材**（用户 2026-11-27 确认，CHARTER 第三节第 1 条）。条款见下节。只作造型参照，不作贴图、不作 AI 生成输入、不入游戏资源。 |

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

对本图的适用性：**待核实**。渠道（API）、居住地（上海）、生成输入（不含 MXGARAGE 素材）均已由用户确认。按 Services Agreement 摘要，非 EEA / 瑞士客户的合同方为 OpenAI OpCo, LLC、适用加州法律（原文未取得）。仍有两项未核实：一是 OpenAI [API 支持的国家和地区](https://help.openai.com/en/articles/5347006-openai-api-supported-countries-and-territories)是否包含中国大陆、在不支持的地区使用 API 有何后果（本次页面未能读取）；二是 Usage Policies 与 Sharing & Publication Policy。在这两项核实前沿用上表限制：只作造型参照，不作贴图、不作 AI 生成输入、不入游戏资源。
