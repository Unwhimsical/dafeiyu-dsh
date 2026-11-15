# 安全政策 / Security Policy

## 报告漏洞

如果你发现了安全问题（例如本地接口绕过鉴权、路径穿越、隐私隔离失效、本该私密的内容被发到别处），请**不要开公开 issue**，用 GitHub 的私密渠道报告：

仓库页面 → **Security** → **Report a vulnerability**

请尽量附上受影响的版本或 commit、复现步骤和影响范围。确认后会尽快修复，并在更新说明里致谢（如果你愿意）。

只维护 `main` 分支的最新版本。

## 使用时请注意

- 把 `brain/config.json` 里的 `admin_key` 改成足够长的随机串。
- 记忆大脑默认只监听 `127.0.0.1`，不要改成 `0.0.0.0` 暴露到公网。
- 你自己的配置、记忆库和浏览器登录态只留在本机，不要发给别人，也不要传到公开的地方。

---

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub's private reporting instead: **Security → Report a vulnerability** on the repository page. Include the affected version or commit, steps to reproduce, and the impact. Only the latest `main` is supported.

When running it yourself: set a long random `admin_key`, keep the memory service bound to `127.0.0.1`, and never share your own config, memory database, or browser profiles.
