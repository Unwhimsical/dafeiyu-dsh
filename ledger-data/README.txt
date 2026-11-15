话簿账本 · 本地数据目录
========================

这里是话簿账本的本地文件目录（默认就是仓库根目录下的 ledger-data/）。
原话本身只存在本地 brain.db 里，这里不会自动写任何原话镜像。
想换位置：设环境变量 DAFEIYU_LEDGER_DIR，或在 brain/config.json 里改 ledger.dir。

目录内容：
  exports/                       手动导出的账本文件（POST /api/ledger/export）
  echo-YYYY-MM-DD.txt            手动生成的回顾（POST /api/ledger/echo；定时任务不写文件）

规则：
  - 原话一字不改；纠错另追加更正记录。「彻底删除」会直接删掉数据库里的原话和条目。
  - 18+ 轮次、隔离号 / 隔离会话里的话不进账本。
  - 结构化数据（原话、条目、册子、热度、检索）都在本地 brain.db 里，随 db.backup() 一起备份。
  - 本目录属于运行时数据：绝不能提交到 git、绝不能上传。
    仓库的 .gitignore 已排除 ledger-data/ 下除本说明以外的所有文件。
