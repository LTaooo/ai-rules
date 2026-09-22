#requires -Version 7.0

[CmdletBinding()]
param(
    [ValidateNotNullOrEmpty()]
    [string]$UserHome = $HOME
)

$ErrorActionPreference = 'Stop'

function Assert-PlainPath([string]$Path, [bool]$Directory) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "拒绝写入联接或符号链接路径：$Path"
    }
    if ($item.PSIsContainer -ne $Directory) {
        throw "路径类型不正确：$Path"
    }
}

function Write-AtomicFile([string]$Path, [byte[]]$Bytes) {
    $temporary = Join-Path (Split-Path -Parent $Path) ('.rule-sync-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllBytes($temporary, $Bytes)
        [IO.File]::Move($temporary, $Path, $true)
    }
    finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force
        }
    }
}

try {
    if (-not $IsWindows) { throw '此同步脚本仅用于 Windows。' }
    $UserHome = [IO.Path]::GetFullPath($UserHome)
    $expectedRoot = [IO.Path]::GetFullPath((Join-Path $UserHome 'ai-rule'))
    if (-not [string]::Equals($PSScriptRoot, $expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw '请将仓库放在当前用户主目录的 ai-rule 文件夹下，以匹配模板中的 ~/ai-rule 路径。'
    }

    $template = Join-Path $PSScriptRoot 'AGENTS-TEMP.md'
    Assert-PlainPath $template $false
    if (-not (Test-Path -LiteralPath $template -PathType Leaf)) { throw '缺少 AGENTS-TEMP.md，未同步任何文件。' }
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'AGENTS.md') -PathType Leaf)) { throw '缺少全局规则 AGENTS.md。' }
    $templateBytes = [IO.File]::ReadAllBytes($template)
    if ([string]::IsNullOrWhiteSpace([Text.Encoding]::UTF8.GetString($templateBytes))) { throw 'AGENTS-TEMP.md 不能为空。' }
    $templateHash = [Convert]::ToBase64String($templateBytes)

    $targets = @(
        @{ RelativePath = '.codex/AGENTS.md'; BackupName = 'codex-AGENTS.md' },
        @{ RelativePath = '.claude/CLAUDE.md'; BackupName = 'claude-CLAUDE.md' }
    )
    $changes = @()
    foreach ($target in $targets) {
        $destination = Join-Path $UserHome $target.RelativePath
        $parent = Split-Path -Parent $destination
        Assert-PlainPath $parent $true
        Assert-PlainPath $destination $false
        $exists = Test-Path -LiteralPath $destination -PathType Leaf
        $originalBytes = [byte[]]@()
        if ($exists) { $originalBytes = [IO.File]::ReadAllBytes($destination) }
        if ($exists -and [Convert]::ToBase64String([byte[]]$originalBytes) -eq $templateHash) {
            Write-Host "跳过（内容相同）：$destination"
            continue
        }
        $changes += @{
            Path = $destination
            Parent = $parent
            Existed = $exists
            OriginalBytes = [byte[]]$originalBytes
            BackupName = $target.BackupName
        }
    }

    if ($changes.Count -eq 0) {
        Write-Host '两个入口均已是最新模板，无需同步。'
        exit 0
    }

    $existing = @($changes | Where-Object { $_.Existed })
    if ($existing.Count -gt 0) {
        $backupRoot = Join-Path $PSScriptRoot '.sync-backups'
        Assert-PlainPath $backupRoot $true
        $backupDirectory = Join-Path $backupRoot ((Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
        foreach ($change in $existing) {
            [IO.File]::WriteAllBytes((Join-Path $backupDirectory $change.BackupName), $change.OriginalBytes)
        }
        Write-Host "原文件已备份：$backupDirectory"
    }

    $applied = [Collections.Generic.List[object]]::new()
    try {
        foreach ($change in $changes) {
            Assert-PlainPath $change.Parent $true
            Assert-PlainPath $change.Path $false
            New-Item -ItemType Directory -Path $change.Parent -Force | Out-Null
            Write-AtomicFile $change.Path $templateBytes
            $applied.Add($change)
            if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($change.Path)) -ne $templateHash) {
                throw "写入后校验失败：$($change.Path)"
            }
            Write-Host "已同步：$($change.Path)"
        }
    }
    catch {
        $syncFailure = $_
        for ($index = $applied.Count - 1; $index -ge 0; $index--) {
            $change = $applied[$index]
            try {
                Assert-PlainPath $change.Parent $true
                Assert-PlainPath $change.Path $false
                if ($change.Existed) { Write-AtomicFile $change.Path $change.OriginalBytes }
                else { Remove-Item -LiteralPath $change.Path -Force }
                Write-Host "已回滚：$($change.Path)"
            }
            catch { Write-Warning "回滚失败，请使用备份恢复：$($change.Path)；$($_.Exception.Message)" }
        }
        throw $syncFailure
    }
    Write-Host '同步完成，仅更新 Codex 和 Claude Code 的 Markdown 入口。'
}
catch {
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
    exit 1
}
