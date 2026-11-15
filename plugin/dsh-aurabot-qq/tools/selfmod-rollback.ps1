<#
  大肥鱼自改回滚（配合插件 src/security/selfmod.js 的审计日志）
  用法：
    .\selfmod-rollback.ps1 -List                 # 列最近 30 次自改（编号、时间、区域、文件）
    .\selfmod-rollback.ps1 -Id <编号>            # 还原这一次改动前的文件（先 -DryRun 看看）
    .\selfmod-rollback.ps1 -Last 3               # 把最近 3 次改动倒序还原
    .\selfmod-rollback.ps1 -Id <编号> -DryRun    # 只说会做什么，不动文件
  还原前会把「现在的文件」再拍一份到 backups\rollback-<时间>\，所以回滚本身也能撤销。
  本次改动前文件不存在（新建的）→ 把新文件挪进 backups\rollback-<时间>\，不直接删除。
#>
param(
  [switch]$List,
  [string]$Id = '',
  [int]$Last = 0,
  [switch]$DryRun,
  [string]$DataDir = $(if ($env:AURABOT_DATA_DIR) { $env:AURABOT_DATA_DIR } else { (Join-Path $env:USERPROFILE '.dsh\plugins-data\dafeiyu') })
)
$ErrorActionPreference = 'Stop'
$root = Join-Path $DataDir 'selfmod'
$log = Join-Path $root 'selfmod.log.jsonl'
if (-not (Test-Path $log)) { Write-Host "没有自改日志：$log"; exit 0 }
$entries = Get-Content -LiteralPath $log -Encoding UTF8 | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json }
$changed = @($entries | Where-Object { $_.changed })
# 回滚自己写的记录（tool=rollback）只用来列，不参与 -Id / -Last 挑选，免得「回滚回滚」把文件当新建的删掉
$undoable = @($changed | Where-Object { $_.tool -ne 'rollback' })
if ($List -or (-not $Id -and $Last -le 0)) {
  $changed | Select-Object -Last 30 | ForEach-Object { '{0}  {1}  [{2}]  {3}  {4}' -f $_.id, $_.at, $_.zone, $_.file, $_.reason }
  exit 0
}
# PS5 的 if 表达式会把单元素数组拆成对象（PSCustomObject 没有 .Count），外面再包一层 @()
$pick = @(if ($Id) { $undoable | Where-Object { $_.id -eq $Id } } else { $undoable | Select-Object -Last $Last })
if (-not $pick.Count) { Write-Host "找不到编号 $Id"; exit 1 }
[array]::Reverse($pick)
$rb = Join-Path $root ('backups\rollback-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
foreach ($e in $pick) {
  $file = $e.file
  if ((Test-Path -LiteralPath $file)) {
    $keep = Join-Path $rb (($file -replace '^([A-Za-z]):', '$1') -replace '^[\\/]+', '')
    if ($DryRun) { Write-Host "[演练] 先把现在的 $file 存到 $keep" } else { New-Item -ItemType Directory -Force (Split-Path $keep) | Out-Null; Copy-Item -LiteralPath $file -Destination $keep -Force }
  }
  if ($e.existed -and $e.backup) {
    if (-not (Test-Path -LiteralPath $e.backup)) { Write-Warning "快照不见了：$($e.backup)，跳过 $file"; continue }
    if ($DryRun) { Write-Host "[演练] 用 $($e.backup) 还原 $file" } else { Copy-Item -LiteralPath $e.backup -Destination $file -Force; Write-Host "已还原 $file（$($e.id)）" }
  } elseif ($e.existed -eq $false) {
    if ($DryRun) { Write-Host "[演练] $file 是那次新建的，挪进 $rb" } elseif (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force; Write-Host "已撤掉新建的 $file（副本在 $rb）" }
  }
  if (-not $DryRun) {
    $line = [ordered]@{ id = 'rollback-' + $e.id; at = (Get-Date).ToString('o'); tool = 'rollback'; zone = $e.zone; file = $file; changed = $true; reason = "回滚 $($e.id)"; backup = $rb } | ConvertTo-Json -Compress
    Add-Content -LiteralPath $log -Value $line -Encoding UTF8
  }
}
Write-Host '完成。模块文件改动保存即自动重载；插件本体（src/）要在 DSH 里重载插件或重启 DSH 才生效。'
