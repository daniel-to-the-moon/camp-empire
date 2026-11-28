# 下一版本：接入第一批已选定音效（待办）

制定：2026-11-28，音效师。维护者同日验收 9 条素材并要求入库，接入放到下一版本。本文件只写规格与待办，不含播放实现。音频接入代码由 Claude 编写、GPT 修 bug；音效师不认领接入 PR。

对齐：[issue #36](https://github.com/daniel-to-the-moon/camp-empire/issues/36) 音效方案；不把 [issue #37](https://github.com/daniel-to-the-moon/camp-empire/issues/37) 的路边唱歌、弹琴、蹦迪纳入本批。素材出处与许可见 [assets/LEDGER.md](../assets/LEDGER.md)。

## 本批已入库、下一版本应接入

| 仓库路径 | 触发（玩法结果，不是动画本身） | 播放方式 |
|---|---|---|
| `assets/audio/sfx-amb-day-gammagool-slovenian-forest.mp3` | 白天营地环境底 | 循环；与夜晚互斥；默认要安静，音量低于一次性提示 |
| `assets/audio/sfx-amb-night-nox-cricket-calm.mp3` | 夜晚环境底 | 循环；与白天互斥 |
| `assets/audio/sfx-veh-start-kikevilaplana-gravel.mp3` | 车辆启动成功 | 一次性；已裁为前半段，不要再播后半段怠速 |
| `assets/audio/sfx-veh-idle-andrewalexander-loop.mp3` | 行驶中 / 怠速 | 循环；熄火或离开驾驶态时淡出停止 |
| `assets/audio/sfx-veh-pass-mieckevanhoek-first5s.mp3` | 会车 | 一次性；文件已是前 5 秒。不要当作泊入或熄火 |
| `assets/audio/sfx-ui-click-kenney-select-001.ogg` | 界面轻点 | 一次性 |
| `assets/audio/sfx-rwd-purchase-mixkit-achievement-bell.mp3` | 支付 / 购买成功（如买侧边帐） | 一次性；在结算完成时触发，表演不得拖住结算 |
| `assets/audio/sfx-rwd-collect-kenney-confirmation-002.ogg` | 收取停车费成功 | 一次性；同上，以玩法结果为准 |
| `assets/audio/sfx-rwd-gift-qvantor-modal-chime.mp3` | 每日礼物实际入账 | 一次性；只在入账发生时播，读档或回放不得补播 |

## 网页音频硬约束（接入时必须遵守）

- 浏览器首次用户手势内调用 `AudioContext.resume()`，在解锁前不发出声。
- 总静音与分组音量（建议至少：环境、车辆、界面/奖励）用 `GainNode` 或同等分组，不要各处写死音量。
- 页面隐藏（`visibilitychange` / 后台标签）时停止循环类声音；回到前台按当前状态续播或重新开始循环，**不得把隐藏期间积压的一次性音效补播出来**。
- 读档、离线回放、跨标签页同步到达时，只反映「现在」的循环态，禁止爆发补播历史事件。
- 发布格式本批已是 MP3 / OGG；不要为接入再转一层未经台账的格式。Opus / CAF 等仍待核实，本批不必引入。
- 安静是治愈感的一部分：环境底要低、稀疏；不要把营地做成持续热闹的声景。

## 明确不在本批、不要顺便实现

- **刹车**：先前候选是手刹放下，不是脚踩刹车。维护者要求重新收集后再验收，本批不要用旧刹车文件，也不要先接占位刹车声。
- 操作失败、泊入 / 熄火、行驶风声、访客到访：维护者尚未选定，不要入库也不要先接占位。
- 营主引导动作（招手、指位、倒车手势、OK、送别）：是否必须有声音仍待维护者决定。
- issue #37 的路边唱歌、弹琴、蹦迪。
- 天气、篝火：本阶段不扩展。

## 仍待核实（接入或替换原文件时一并处理）

- Freesound 6 条目前是官方 HQ 预览 MP3（启动、会车已再裁切）；有站点账号后应替换为原文件，并按同一裁切规则重裁、更新 LEDGER 哈希。
- Mixkit Achievement bell 的 User Terms 未全文归档。
- AndrewAlexander 怠速是否涉及车型商标（Honda 风险已告知，维护者仍选定）。
- 设备实测体积、解码内存、距离衰减与冷却数值、Safari / iOS 中断态。
