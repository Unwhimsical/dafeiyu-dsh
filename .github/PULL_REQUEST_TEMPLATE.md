## 改了什么 / What changed

<!-- 一两句话说明改动和原因；有关联的 Issue 写 Closes #123 -->

## 怎么验证的 / How was it tested

- [ ] `cd brain && python -m pytest -q`
- [ ] `cd plugin/dsh-aurabot-qq && npm test`
- [ ] 手动验证（请说明）/ Manual check (describe):

## 检查清单 / Checklist

- [ ] **隐私**：没有真实的 QQ 号、群号、抖音号、昵称、群名、聊天记录、人设原文 / **Privacy**: no real QQ / group / Douyin IDs, nicknames, group names, chat logs or persona text
- [ ] **密钥**：没有 API Key、令牌、Cookie、密码、暗号或暗号哈希，也没有本机用户名路径 / **Secrets**: no API keys, tokens, cookies, passwords, passphrases or hashes, no local user-name paths
- [ ] 跑过 `python scripts/scan_secrets.py` 且通过 / `python scripts/scan_secrets.py` passes
- [ ] 新配置项有默认值，需要填写的值只以占位符写进 `*.example.json` / New settings have defaults; required values appear only as placeholders in `*.example.json`
- [ ] 用户能感知的变化已写进 `CHANGELOG.md` 的「未发布」/ User-visible changes are noted under "未发布" in `CHANGELOG.md`
- [ ] 新引入的第三方代码已在 `THIRD-PARTY-NOTICES.md` 署名 / New third-party code is credited in `THIRD-PARTY-NOTICES.md`
