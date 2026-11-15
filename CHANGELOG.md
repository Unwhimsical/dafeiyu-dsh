# 更新记录 / Changelog

本项目的重要变化都记录在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
QQ 插件自己的历史（含上游）见 [`plugin/dsh-aurabot-qq/CHANGELOG.md`](./plugin/dsh-aurabot-qq/CHANGELOG.md)。

All notable changes to this project are documented here. The QQ plugin's own history (including upstream) is in [`plugin/dsh-aurabot-qq/CHANGELOG.md`](./plugin/dsh-aurabot-qq/CHANGELOG.md).

## 未发布 / Unreleased

### 隐私 / Privacy

- 记忆大脑：18+ 轮次和隔离号的话不再写进 `turns` 表和 spill 明文流水（和话簿共用 `ledger.skip_reason` 一个判断，判断出错按不写处理）；18+ 窗口里新记的记忆自动加 `nsfw` 隐藏标签；新增 `scripts/purge_sensitive.py`，升级后可清掉以前存进去的（只打印条数）。
  Brain: 18+ and isolated turns are no longer written to the `turns` table or the plaintext spill log (same predicate as the ledger, failing closed); memories created inside an 18+ window are tagged `nsfw`; new `scripts/purge_sensitive.py` removes previously stored rows and prints counts only.
- QQ 插件：隔离号的聊天流水单独放（`isolatedStore`，可关成完全不落盘），主人私聊不受影响；`adultStore.noDisk` 现在也覆盖交接笔记（只放内存）和 DSH 会话（窗口关闭后归档并删除那次会话的文件）。
  QQ plugin: isolated contacts' chat logs go to a separate directory (`isolatedStore`, can be turned off entirely); `adultStore.noDisk` now also covers handoff notes (memory only) and DSH sessions (archived and deleted after the window closes).
- 暗号模块不再自动改记忆隔离名单 `ext.memcore.isolatePeople`，只在日志里（打码）提醒主人手动添加；memcore 传给大脑的 `isolated` 不再包含主人本人。
  The handshake module no longer edits `ext.memcore.isolatePeople` automatically; it only logs a masked reminder. memcore no longer flags the owner's own chat as isolated.

## [0.1.0] - 2026-11-15

首次公开发布 / First public release.

### 新增 / Added

- **记忆大脑**（`brain/`，Python / FastAPI / SQLite）：长期记忆与遗忘曲线、按人和会话的隐私隔离、出站防泄漏守卫、话簿账本、MCP 接口，以及记忆星图、工作台和控制台网页。
  Memory brain: long-term memory with a forgetting curve, per-person / per-conversation privacy isolation, an outbound leak guard, an utterance ledger, an MCP endpoint, and the Xingtu star map, workbench and console web UI.
- **QQ 插件**（`plugin/dsh-aurabot-qq/`）：基于上游 dsh-aurabot-qq v1.1.24 的修改版，增加上下文计划、心情驱动的说话长短与频率、群静音、公开输出守卫、跨平台身份对照等。
  QQ plugin: a modified fork of upstream dsh-aurabot-qq v1.1.24 with context planning, mood-driven reply length and frequency, group mute, a public-output guard and cross-platform identity mapping.
- **32 个扩展模块**（`ext-modules/`）及模块 API 文档与类型定义。
  32 extension modules plus module API docs and type definitions.
- 配置模板（全部为占位符）、人设模板、演示数据、脱敏扫描脚本。
  Placeholder-only config templates, a persona template, demo data and a secret-scan script.
- 社区文件与 CI：贡献指南、行为准则、Issue / PR 模板，GitHub Actions 跑记忆大脑测试（Python 3.10 / 3.12）、插件测试（Node 22 / 24）、模块语法检查和脱敏扫描。
  Community files and CI: contributing guide, code of conduct, issue / PR templates, and GitHub Actions for brain tests, plugin tests, module syntax checks and the secret scan.

### 默认设置 / Defaults

- 抖音点赞 / 评论 / @ / 分享默认关闭，可在 `behaviour.json` 中开启。
  Douyin like / comment / mention / share actions are off by default and can be enabled in `behaviour.json`.
- 话簿只把原话存进本地数据库，不写明文镜像；18+ 轮次和隔离会话不进话簿；彻底删除会真正删除记录。
  The ledger stores utterances only in the local database (no plaintext mirror); 18+ and isolated turns are never recorded; erase truly deletes rows.
- 18+ 能力默认关闭，开口流程由使用者在本地配置，仓库不含暗号或暗号哈希。
  18+ features are off by default; the handshake flow is configured locally and no passphrases or hashes are shipped.
- 插件默认总开关关闭、试运行开启。网页阅读只读，不下载文件。
  The plugin starts with the master switch off and dry-run on. Web reading is read-only and never downloads files.
- 不附带 SnowLuma、DSH NEXT、模型权重和「大肥鱼」形象素材。
  SnowLuma, DSH NEXT, model weights and the "Dafeiyu" character art are not bundled.

[0.1.0]: https://github.com/Unwhimsical/dafeiyu-dsh/releases/tag/v0.1.0
