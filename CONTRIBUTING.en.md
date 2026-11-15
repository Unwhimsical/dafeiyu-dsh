# Contributing

[简体中文](./CONTRIBUTING.md) | English

Thanks for helping! Bug reports, ideas, documentation fixes and code are all welcome. Please read the [Code of Conduct](./CODE_OF_CONDUCT.md) first.

## The most important rule: never commit private information

This project handles chat logs, so privacy rules are strict. Issues, pull requests, screenshots, logs and test data must **never contain**:

- Real QQ numbers, group IDs, Douyin IDs, nicknames or group names
- Chat transcripts, memory-database contents or real persona text
- API keys, tokens, cookies, passwords, passphrases or passphrase hashes
- Your Windows user name in local paths (the part after `C:\Users\`)

Use obvious placeholders in examples: `10000001`, `YOUR_QQ_HERE`, `p:10001`, `C:\Users\<username>\...`. Redact logs before posting them.

Before committing, run:

```bash
python scripts/scan_secrets.py
```

CI runs the same scan and fails on any hit.

## Bugs and feature requests

- Use the [issue templates](https://github.com/Unwhimsical/dafeiyu-dsh/issues/new/choose).
- **Do not report security issues publicly** — follow [SECURITY.md](./SECURITY.md).
- The README FAQ and [`brain/docs/功能说明.md`](./brain/docs/功能说明.md) (Chinese) answer many common questions.

## Development setup

```bash
git clone https://github.com/Unwhimsical/dafeiyu-dsh.git
cd dafeiyu-dsh

# Memory brain: Python 3.10+
cd brain
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt
python -m pytest -q
cd ..

# QQ plugin: Node 22.13+, tests don't need DSH
cd plugin/dsh-aurabot-qq
npm test
cd ../..

# Syntax check for extension modules
for f in ext-modules/*/*.mjs; do node --check "$f"; done
```

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep changes small and focused — one topic per PR.
3. For bug fixes, add a test that reproduces the problem when possible; for features, add tests or describe how to verify manually.
4. Make sure the tests and the secret scan pass.
5. Add a line under "未发布" (Unreleased) in [CHANGELOG.md](./CHANGELOG.md) for user-visible changes.
6. Fill in the PR template, including the privacy checklist.

### Conventions

- Follow [`.editorconfig`](./.editorconfig): Python 4 spaces; JS / JSON / Markdown 2 spaces; UTF-8.
- Comments and user-facing text are in Chinese; identifiers are in English.
- **Do not rename** the plugin package `dsh-aurabot-qq`, the `/aurabot/api/*` routes, the `aurabot-*` session prefixes or the `__aurabot*` globals — they are runtime contracts.
- New settings need sane defaults and must not crash when unset; values users must fill in go into `*.example.json` as placeholders only.
- Keep defaults conservative: features that involve 18+ content or cost money are off by default, and the plugin keeps starting with the master switch off and dry-run on.
- Web-reading features are read-only and never download files in the browser.
- Don't commit third-party binaries, model weights or character art. When adding third-party code, record its license and attribution in [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).

### Commit messages

One clear sentence describing the change, in Chinese or English.

## License

Contributions are released under the [MIT](./LICENSE) license. Keep the upstream copyright notice when changing `plugin/dsh-aurabot-qq/`.
