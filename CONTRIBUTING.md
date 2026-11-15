# 参与贡献

简体中文 | [English](./CONTRIBUTING.en.md)

谢谢你愿意帮忙！提 Bug、提建议、改文档、写代码都欢迎。参与前请先读一下 [行为准则](./CODE_OF_CONDUCT.md)。

## 最重要的一条：不要提交任何私人信息

这是一个会接触聊天记录的项目，所以对隐私格外严格。Issue、PR、截图、日志、测试数据里都**不能出现**：

- 真实的 QQ 号、群号、抖音号、昵称、群名
- 聊天记录原文、记忆库内容、人设原文
- API 密钥、令牌、Cookie、密码、暗号或暗号哈希
- 本机路径里的 Windows 用户名（`C:\Users\` 后面那一段）

需要举例时用明显的占位值：`10000001`、`YOUR_QQ_HERE`、`p:10001`、`C:\Users\<你的用户名>\...`。贴日志前请先打码。

提交前运行：

```bash
python scripts/scan_secrets.py
```

CI 也会跑这个扫描，命中就会失败。

## 报告 Bug / 提建议

- Bug 和功能建议请用 [Issue 模板](https://github.com/Unwhimsical/dafeiyu-dsh/issues/new/choose)。
- **安全问题不要公开提 Issue**，按 [SECURITY.md](./SECURITY.md) 私下报告。
- 提问前可以先看 README 的「常见问题」和 [`brain/docs/功能说明.md`](./brain/docs/功能说明.md)。

## 开发环境

```bash
git clone https://github.com/Unwhimsical/dafeiyu-dsh.git
cd dafeiyu-dsh

# 记忆大脑：Python 3.10+
cd brain
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt
python -m pytest -q
cd ..

# QQ 插件：Node 22.13+，测试不需要 DSH
cd plugin/dsh-aurabot-qq
npm test
cd ../..

# 扩展模块语法检查
for f in ext-modules/*/*.mjs; do node --check "$f"; done
```

## 提交 Pull Request

1. Fork 本仓库，从 `main` 拉一个新分支。
2. 改动尽量小而集中，一个 PR 做一件事。
3. 修 Bug 时尽量补一条能复现问题的测试；新功能请附上测试或说明怎么手动验证。
4. 跑通上面的测试和脱敏扫描。
5. 用户能感知到的变化，在 [CHANGELOG.md](./CHANGELOG.md) 的「未发布」里加一行。
6. 提 PR 时按模板填写，并勾选隐私检查项。

### 代码约定

- 缩进和换行遵守 [`.editorconfig`](./.editorconfig)：Python 4 空格，JS / JSON / Markdown 2 空格，UTF-8。
- 注释和用户能看到的文字用中文；标识符用英文。
- **不要改**插件的包名 `dsh-aurabot-qq`、`/aurabot/api/*` 路由、`aurabot-*` 会话前缀和 `__aurabot*` 全局变量，这些是运行时约定，改了会断线或丢失会话。
- 新的配置项要有合理的默认值，没配置时不能崩；需要用户填的值放进 `*.example.json`，只用占位符。
- 默认行为保持保守：涉及 18+ 或会产生费用的功能默认关闭；不要改变插件「总开关关、试运行开」的初始状态。
- 网页阅读类功能只读，不在浏览器里下载文件。
- 不要把第三方二进制、模型权重、形象素材提交进仓库。引入新的第三方代码时，请在 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) 里补上许可和署名。

### 提交信息

用一句话说清楚改了什么，中文或英文都可以，例如：`记忆大脑：修复群聊来源标签丢失`。

## 许可

提交到本仓库的贡献默认以 [MIT](./LICENSE) 许可发布。修改 `plugin/dsh-aurabot-qq/` 时请保留上游的版权声明。
