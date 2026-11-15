# 第三方组件与许可声明（THIRD-PARTY NOTICES）

本仓库（MIT，仅覆盖自写代码）**组合**了以下上游与第三方组件。这些组件按其各自许可协议
分发，**不归本仓库 MIT 覆盖**，也不随本仓库打包二进制/权重。请在使用、再分发时遵守各自条款。

> 表中版本号仅供参考，请以你部署时的上游版本为准。

---

## 1. 机器人框架（运行时依赖，按包名识别）

| 组件 | 许可 | 版本 | 上游 / 仓库 | 说明 |
|---|---|---|---|---|
| **`dsh-aurabot-qq`** | **MIT** | v1.1.24 | `accomplish07zrh-eng/dsh-aurabot-qq` | 本项目的运行基座。本仓库的扩展模块挂在其 `modules/` 下。**必须保留其 MIT 版权声明**（见下文）。 |
| **DSH NEXT**（桌面程序） | 见上游 | — | 上游桌面端 | 宿主程序，不进仓库，只声明依赖。 |
| **`dsh-pet`**（桌宠） | **MIT**（代码） | — | 上游 | 桌宠框架。**形象素材单独许可**，见第 2 节。 |

### `dsh-aurabot-qq` MIT 版权（必须保留）

```
MIT License
Copyright (c) 2026 Aurabot contributors
```

> 本仓库在 `plugin/dsh-aurabot-qq/` 收录了 **`dsh-aurabot-qq` 的修改版**（基于 v1.1.24 之后的开发版），
> 上游 MIT `LICENSE` 与上游 `THIRD-PARTY-NOTICES.md` 原样保留在该目录内，来源与改动说明见 `plugin/UPSTREAM.md`。
> 仓库名使用 `dafeiyu-dsh` 而非 `dsh-aurabot-qq`，以避免被误认为官方插件；
> 上游包名、`/aurabot/api/*` 路由、会话前缀 `aurabot-*`、全局变量 `__aurabot*` 均按
> 运行时契约**原样保留**，不可改名（改名会失忆 / 断线）。
> `plugin/dsh-aurabot-qq/assets/dafeiyu.jpg` 是上游仓库自带的默认头像，按上游原样分发。

---

## 2. 形象素材（CC BY-NC-SA 4.0 · 非商用）

| 组件 | 许可 | 作者 | 能否进公开仓库 |
|---|---|---|---|
| **「大肥鱼 / whale-fantasy」形象**（`skin.css`、`patches.css`、预览图、`assets/*.mp4`） | **CC BY-NC-SA 4.0**（署名-非商业-相同方式共享） | stushansusu | ❌ **不打包**。只说明怎么从 dsh-market / 原仓库装。 |

- ✅ 个人免费使用、开源展示可，但必须署名，且**非商用**。
- ❌ 收费 / 广告 / 商业产品：名字与形象都要换成自己的。
- CC BY-NC-SA 带 **SA**：本仓库代码用 MIT，但「大肥鱼形象」**不在 MIT 授权范围内**
  （见 `LICENSE` 文件末尾的范围说明）。
- 桌宠的动画包（来自 dsh-pet 的 pet pack）同样是 CC BY-NC-SA 4.0、同样不随本仓库分发，
  署名见 [`plugin/dsh-aurabot-qq/THIRD-PARTY-NOTICES.md`](plugin/dsh-aurabot-qq/THIRD-PARTY-NOTICES.md)。

---

## 3. 网关 / 协议

| 组件 | 许可 | 说明 |
|---|---|---|
| **SnowLuma** | SnowLuma 源码可见非商业许可 + EULA（官方发行包） | QQ 网关（OneBot v11）。**不随本仓库分发**，详见下节。 |
| **OneBot** | 见上游 | 机器人协议标准。 |

### 关于 SnowLuma（请务必阅读）

SnowLuma 是**第三方非官方** QQ 协议 / OneBot 网关，与腾讯或 QQ **无隶属关系**。本仓库**不附带、不分发**其官方发行包或专有组件。

- 请自行到官方发布页下载并安装：https://github.com/SnowLuma/SnowLuma/releases
- 安装前请自行阅读其 **EULA** 与 **PRIVACY**（隐私说明）。
- 其 EULA 仅允许**个人或其他非商业**使用（商业使用须事先取得著作权人书面授权）。
- EULA 第 5.4 条限制：不得将其专有组件复制、修改、单独再分发或再许可；**不得将其并入第三方安装包或 Docker 镜像，也不得通过自动化脚本部署**——除非事先取得著作权人的书面授权。
- 本仓库插件里保留了上游提供的 SnowLuma **辅助安装流程**。该流程**可能与上述 5.4 条冲突**。是否使用由你自行判断；更稳妥的做法是按官方说明手动下载、解压并自行配置。
- 使用非官方客户端接入 QQ **可能违反平台条款并有封号风险**，风险自负。

---

## 4. 语音 / 识别模型与引擎（权重与二进制不进仓库）

| 组件 | 许可 | 说明 |
|---|---|---|
| **sherpa-onnx** | Apache-2.0 | 离线语音识别/合成运行时。 |
| **paraformer / SenseVoice** | 见模型卡（通常 Apache-2.0 / 自定义） | ASR / 说话人相关模型权重。 |
| **edge-tts** | MIT | 微软在线 TTS（走网络，无二进制）。 |
| **CosyVoice / GPT-SoVITS** | 见上游（多含科研/非商用条款） | 语音克隆/合成。 |
| **Breeze** | 见上游 | 本地 TTS 代理相关。 |

> 权重（`.onnx` / `.bin` 等）与任何模型二进制**一律不进仓库**，只在文档/配置里列名字 + 版本 + 上游地址。

---

## 5. 桌宠 UI / 皮肤中心（依赖声明）

| 组件 | 许可 | 版本 |
|---|---|---|
| `@linxin666/dsh-client-ui-skin-center` | Apache-2.0 | 0.4.14 |
| `lightningcss` / `lightningcss-win32-x64-msvc` | MIT | — |
| `dsh-boot-animation` | BSD-3-Clause | 0.4.4（其内嵌片源同条款，勿整包转存 `lib/clips.data.js`） |

---

## 6. 在线服务 SDK / API（凭据不进仓库）

以下服务仅以「配置键 + 环境变量」形式被引用，Key / Cookie / Token **绝不进仓库**，
运行时由你本机的配置文件（插件数据目录里的 `config.json`、记忆大脑的 `brain/config.json`）提供：

- 图像生成（如兼容 OpenAI 的 image API）
- B 站（bili）、小黑盒（heybox）、网易云（song.netease）等（按各平台 ToS 使用）
- 各 LLM 提供方（`llm.base_url` / `api_key`）

---

## 7. 本仓库对上游的修改（plugin/）

QQ 插件 `dsh-aurabot-qq` 以修改版（fork）的形式放在 `plugin/dsh-aurabot-qq/`，上游来源、
基于的版本和主要改动见 [`plugin/UPSTREAM.md`](plugin/UPSTREAM.md)。使用或再分发时请：

- 保留上游版权与 LICENSE（`plugin/dsh-aurabot-qq/LICENSE`）以及上游的第三方声明；
- 注明你在此基础上的修改。

---

## 8. 记忆大脑网页控制台（brain/web/vendor，原样随仓库分发）

| 组件 | 许可 | 版本 | 说明 |
|---|---|---|---|
| **React** / **ReactDOM**（`react.production.min.js`、`react-dom.production.min.js`） | MIT，© Meta Platforms, Inc. and affiliates | 18.3.1（文件头自带许可注释） | 控制台 UI。 |
| **three.js**（`three-0.170.0.global.min.js`） | MIT，© 2010-2024 three.js authors | 0.170.0 | 记忆星图 3D 渲染。 |
| **companion-memory** | MIT | — | 记忆大脑部分算法的移植来源，见 `brain/CREDITS.md`。 |
| **花园背景 `brain/web/garden/garden.jpg`** | 公有领域（Public Domain） | — | John Atkinson Grimshaw（1836–1893）的月夜湖景油画复制品，作者逝世已逾百年。 |

---

## English summary

This repository's own code is MIT-licensed (see [`LICENSE`](LICENSE)). It also contains or refers to third-party work under other terms:

- **`plugin/dsh-aurabot-qq/`** is a modified fork of [dsh-aurabot-qq](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq) (MIT, © 2026 Aurabot contributors). Its upstream `LICENSE` and `THIRD-PARTY-NOTICES.md` (including dsh-pet, MIT) are kept unchanged in that directory; see [`plugin/UPSTREAM.md`](plugin/UPSTREAM.md).
- **`brain/web/vendor/`** ships React / ReactDOM 18.3.1 (MIT, © Meta Platforms, Inc. and affiliates) and three.js 0.170.0 (MIT, © three.js authors) unmodified.
- **companion-memory** (MIT): parts of the memory brain are ported from it; see [`brain/CREDITS.md`](brain/CREDITS.md).
- **`brain/web/garden/garden.jpg`** is a reproduction of a public-domain painting by John Atkinson Grimshaw (1836–1893).
- **Not included**: DSH NEXT; SnowLuma (unofficial QQ gateway; personal / non-commercial EULA whose section 5.4 restricts redistribution and scripted deployment — the plugin's assisted-install flow may conflict with it, use at your own discretion; using unofficial QQ clients may get accounts suspended); speech models and engines; online-service credentials; and the "Dafeiyu" character art and desktop-pet animation pack (**CC BY-NC-SA 4.0, non-commercial**).
