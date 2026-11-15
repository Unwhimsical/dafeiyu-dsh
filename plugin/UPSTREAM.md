# plugin/dsh-aurabot-qq —— 上游来源与改动说明

这个目录是 QQ 插件 **dsh-aurabot-qq** 的修改版（fork），大肥鱼项目在它上面加了隔离、18+ 闸（默认关）、
上下文计划、心情驱动的说话长短/频率、群静音道别、公开输出守卫等功能。

- **上游仓库**：https://github.com/accomplish07zrh-eng/dsh-aurabot-qq
- **基于版本**：v1.1.24（tag commit `5fb5c01`）之后的开发版，再叠加本项目改动
- **上游许可**：MIT，版权 © 2026 Aurabot contributors。原样保留在 [`dsh-aurabot-qq/LICENSE`](dsh-aurabot-qq/LICENSE)，
  上游自带的第三方声明见 [`dsh-aurabot-qq/THIRD-PARTY-NOTICES.md`](dsh-aurabot-qq/THIRD-PARTY-NOTICES.md)。
- **本项目改动的许可**：同样是 MIT（见仓库根目录 `LICENSE`）。

## 主要改动（相对上游 v1.1.24）

- 新增：`src/chat/ctxplan.js`（上下文计划 / 滚动压缩）、`src/security/public-guard.js`（公开输出守卫）、
  `src/security/neutralize.js`、`src/security/selfmod.js`、`src/features/style.js`（心情驱动长短/频率）、
  `src/features/people.js`（跨平台身份对照）、`src/song/short-sing.js`、`src/voice/rvc.js`、`tools/selfmod-rollback.ps1` 及对应测试。
- 修改：`src/chat/hub.js`、`src/chat/access.js`、`src/core/config.js`、`src/core/modules.js`、`src/host.js` 等约 40 个文件。
- 可以用 `diff -r` 对比上游 v1.1.24 查看全部差异。

## 安装

把整个 `dsh-aurabot-qq/` 目录放到 DSH 数据目录下的 `profiles/desktop/node_modules/dsh-aurabot-qq/`，
把上一级的 `config.example.json` 复制成插件数据目录里的 `config.json` 后再填自己的号码和令牌。
（包名、`/aurabot/api/*` 路由、`aurabot-*` 会话前缀按上游原样保留，改名会断线 / 失忆。）

## 没有放进来的东西

- `node_modules/`（运行时依赖，安装时自己装）
- 所有 `*.bak*` 备份、调试脚本
- 任何真实配置、令牌、QQ 号、聊天记录、登录态
