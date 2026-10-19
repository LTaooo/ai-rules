#requires -Version 7.0

[CmdletBinding()]
param(
    [ValidateNotNullOrEmpty()]
    [string]$UserHome = $HOME,
    [string]$ElevatedLogPath = ''
)

$ErrorActionPreference = 'Stop'

function Assert-PlainPath([string]$Path, [bool]$Directory) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "拒绝处理联接或符号链接路径：$Path"
    }
    if ($item.PSIsContainer -ne $Directory) {
        throw "路径类型不正确：$Path"
    }
}

function Test-SymlinkCapable {
    $probeRoot = Join-Path ([IO.Path]::GetTempPath()) ('rule-sync-probe-' + [guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Path $probeRoot -Force | Out-Null
        $probeTarget = Join-Path $probeRoot 'target.txt'
        Set-Content -LiteralPath $probeTarget -Value 'probe'
        New-Item -ItemType SymbolicLink -Path (Join-Path $probeRoot 'link.txt') -Value $probeTarget -ErrorAction Stop | Out-Null
        return $true
    }
    catch {
        return $false
    }
    finally {
        Remove-Item -LiteralPath $probeRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Test-EntryLinkCorrect([string]$SourcePath, [string]$DestinationPath) {
    $info = $null
    try { $info = Get-Item -LiteralPath $DestinationPath -Force -ErrorAction Stop } catch { return $false }
    if ($info.PSIsContainer -or -not ($info.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $false }
    $current = [string]@($info.Target)[0]
    if ([string]::IsNullOrWhiteSpace($current)) { return $false }
    return [IO.Path]::GetFullPath($current).Equals([IO.Path]::GetFullPath($SourcePath), [StringComparison]::OrdinalIgnoreCase)
}

function Update-EntryLink([string]$SourcePath, [string]$DestinationPath, [string]$BackupName, [string]$BackupRoot) {
    $expected = [IO.Path]::GetFullPath($SourcePath)
    $parent = Split-Path -Parent $DestinationPath
    Assert-PlainPath $parent $true
    New-Item -ItemType Directory -Path $parent -Force | Out-Null

    $removedBytes = $null
    $info = $null
    try { $info = Get-Item -LiteralPath $DestinationPath -Force -ErrorAction Stop } catch { $info = $null }

    if ($null -ne $info) {
        if ($info.PSIsContainer) { throw "入口路径是目录，拒绝处理：$DestinationPath" }
        if ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            $current = [string]@($info.Target)[0]
            if (-not [string]::IsNullOrWhiteSpace($current) -and [IO.Path]::GetFullPath($current).Equals($expected, [StringComparison]::OrdinalIgnoreCase)) {
                Write-Host "跳过（映射正确）：$DestinationPath"
                return
            }
            Remove-Item -LiteralPath $DestinationPath -Force
            Write-Host "已移除旧映射：$DestinationPath"
        }
        else {
            $removedBytes = [IO.File]::ReadAllBytes($DestinationPath)
            $backupDirectory = Join-Path $BackupRoot ((Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + [guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
            [IO.File]::WriteAllBytes((Join-Path $backupDirectory $BackupName), $removedBytes)
            Write-Host "原文件已备份：$(Join-Path $backupDirectory $BackupName)"
            Remove-Item -LiteralPath $DestinationPath -Force
        }
    }
    else {
        if ([IO.Directory]::GetFileSystemEntries($parent, (Split-Path -Leaf $DestinationPath)).Count -gt 0) {
            Remove-Item -LiteralPath $DestinationPath -Force -Recurse
            Write-Host "已移除失效链接：$DestinationPath"
        }
    }

    try {
        New-Item -ItemType SymbolicLink -Path $DestinationPath -Value $expected -ErrorAction Stop | Out-Null
    }
    catch {
        if ($null -ne $removedBytes) {
            [IO.File]::WriteAllBytes($DestinationPath, $removedBytes)
            Write-Host "映射创建失败，已恢复原文件：$DestinationPath"
        }
        throw "创建符号链接失败（$DestinationPath）：$($_.Exception.Message)"
    }

    $created = Get-Item -LiteralPath $DestinationPath -Force
    $createdTarget = [string]@($created.Target)[0]
    if ([string]::IsNullOrWhiteSpace($createdTarget) -or -not [IO.Path]::GetFullPath($createdTarget).Equals($expected, [StringComparison]::OrdinalIgnoreCase)) {
        throw "映射创建后校验失败：$DestinationPath"
    }
    Write-Host "已创建映射：$DestinationPath -> $expected"
}

function Update-SkillJunctions([string]$RepoSkillsRoot, [string]$ToolSkillsRoot) {
    $failures = [Collections.Generic.List[string]]::new()

    $toolItem = Get-Item -LiteralPath $ToolSkillsRoot -Force -ErrorAction SilentlyContinue
    if ($null -ne $toolItem) {
        if ($toolItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            $failures.Add("工具技能目录本身是联接，拒绝维护：$ToolSkillsRoot")
            return $failures
        }
        if (-not $toolItem.PSIsContainer) {
            $failures.Add("工具技能路径不是目录，拒绝维护：$ToolSkillsRoot")
            return $failures
        }
    }
    else {
        New-Item -ItemType Directory -Path $ToolSkillsRoot -Force | Out-Null
    }

    $managed = @{}
    foreach ($repoItem in (Get-ChildItem -LiteralPath $RepoSkillsRoot -Directory)) {
        if (-not (Test-Path -LiteralPath (Join-Path $repoItem.FullName 'SKILL.md') -PathType Leaf)) { continue }
        $managed[$repoItem.Name] = [IO.Path]::GetFullPath($repoItem.FullName)
    }

    foreach ($name in $managed.Keys) {
        $expected = $managed[$name]
        $link = Join-Path $ToolSkillsRoot $name
        $info = $null
        try { $info = Get-Item -LiteralPath $link -Force -ErrorAction Stop } catch { $info = $null }
        try {
            if ($null -eq $info) {
                if ([IO.Directory]::GetFileSystemEntries($ToolSkillsRoot, $name).Count -gt 0) {
                    Remove-Item -LiteralPath $link -Force -Recurse
                    New-Item -ItemType Junction -Path $link -Value $expected | Out-Null
                    Write-Host "已重建联接（原联接已失效）：$link -> $expected"
                }
                else {
                    New-Item -ItemType Junction -Path $link -Value $expected | Out-Null
                    Write-Host "已创建联接：$link -> $expected"
                }
            }
            elseif ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                $current = [string]@($info.Target)[0]
                if (-not [string]::IsNullOrWhiteSpace($current) -and [IO.Path]::GetFullPath($current).Equals($expected, [StringComparison]::OrdinalIgnoreCase)) {
                    Write-Host "跳过（联接正确）：$link"
                }
                else {
                    Remove-Item -LiteralPath $link -Force -Recurse
                    New-Item -ItemType Junction -Path $link -Value $expected | Out-Null
                    Write-Host "已重建联接：$link -> $expected"
                }
            }
            else {
                Write-Warning "目标为真实文件或目录，跳过不覆盖，请手动处理：$link"
            }
        }
        catch {
            $failures.Add("联接维护失败：$link；$($_.Exception.Message)")
        }
    }

    $repoPrefix = [IO.Path]::GetFullPath($RepoSkillsRoot).TrimEnd('\', '/') + '\'
    foreach ($entry in [IO.Directory]::GetFileSystemEntries($ToolSkillsRoot)) {
        $entryName = [IO.Path]::GetFileName($entry)
        if ($managed.ContainsKey($entryName)) { continue }
        $entryInfo = $null
        try { $entryInfo = Get-Item -LiteralPath $entry -Force -ErrorAction Stop } catch { $entryInfo = $null }
        if ($null -eq $entryInfo) {
            Write-Warning "工具技能目录中存在无法读取的条目，请手动检查：$entry"
            continue
        }
        if ($entryInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            $target = [string]@($entryInfo.Target)[0]
            if (-not [string]::IsNullOrWhiteSpace($target) -and [IO.Path]::GetFullPath($target).StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                Write-Warning "指向仓库但已不在技能清单中的联接，请手动删除：$entry -> $target"
            }
        }
    }

    return $failures
}

try {
    if (-not $IsWindows) { throw '此同步脚本仅用于 Windows。' }
    $UserHome = [IO.Path]::GetFullPath($UserHome)
    $expectedRoot = [IO.Path]::GetFullPath((Join-Path $UserHome 'ai-rule'))
    if (-not [string]::Equals($PSScriptRoot, $expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw '请将仓库放在当前用户主目录的 ai-rule 文件夹下，以匹配映射中的绝对路径。'
    }

    $ruleSource = Join-Path $PSScriptRoot 'RULES.md'
    Assert-PlainPath $ruleSource $false
    if (-not (Test-Path -LiteralPath $ruleSource -PathType Leaf)) { throw '缺少全局规则 RULES.md。' }
    if ([string]::IsNullOrWhiteSpace([Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($ruleSource)))) { throw 'RULES.md 不能为空。' }

    $backupRoot = Join-Path $PSScriptRoot '.sync-backups'
    Assert-PlainPath $backupRoot $true

    if ($ElevatedLogPath) {
        Start-Transcript -LiteralPath $ElevatedLogPath -Force | Out-Null
    }

    $entryTargets = @(
        @{ RelativePath = '.codex/AGENTS.md'; BackupName = 'codex-AGENTS.md' },
        @{ RelativePath = '.claude/CLAUDE.md'; BackupName = 'claude-CLAUDE.md' },
        @{ RelativePath = '.agents/AGENTS.md'; BackupName = 'agents-AGENTS.md' }
    )

    $entryWorkPending = $false
    foreach ($target in $entryTargets) {
        if (-not (Test-EntryLinkCorrect -SourcePath $ruleSource -DestinationPath (Join-Path $UserHome $target.RelativePath))) {
            $entryWorkPending = $true
            break
        }
    }

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $isAdmin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin -and -not $PSBoundParameters.ContainsKey('ElevatedLogPath') -and $entryWorkPending -and -not (Test-SymlinkCapable)) {
        $logFile = Join-Path ([IO.Path]::GetTempPath()) ('rule-sync-elevated-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.log')
        $inner = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "{0}" -UserHome "{1}" -ElevatedLogPath "{2}"' -f $PSCommandPath, $UserHome, $logFile
        Write-Host '当前会话无权限创建符号链接，正在请求管理员授权（在弹出的窗口中选择“是”）……'
        try {
            $process = Start-Process -FilePath 'pwsh' -ArgumentList $inner -Verb RunAs -Wait -PassThru -ErrorAction Stop
        }
        catch {
            throw '已取消或无法完成管理员授权，本次未做任何修改。可开启 Windows 开发者模式后以普通权限重跑。'
        }
        if (Test-Path -LiteralPath $logFile) {
            Get-Content -LiteralPath $logFile
            Remove-Item -LiteralPath $logFile -Force
        }
        if ($process.ExitCode -ne 0) {
            throw '提权运行未全部成功，请查看上方日志处理后重跑。'
        }
        Write-Host '提权同步完成。'
        exit 0
    }

    $failures = [Collections.Generic.List[string]]::new()
    foreach ($target in $entryTargets) {
        try {
            Update-EntryLink -SourcePath $ruleSource -DestinationPath (Join-Path $UserHome $target.RelativePath) -BackupName $target.BackupName -BackupRoot $backupRoot
        }
        catch {
            $failures.Add("入口映射失败：$($target.RelativePath)；$($_.Exception.Message)")
        }
    }

    $junctionFailures = [Collections.Generic.List[string]]::new()
    foreach ($failure in (Update-SkillJunctions (Join-Path $PSScriptRoot 'skills') (Join-Path $UserHome '.claude\skills'))) { $junctionFailures.Add($failure) }
    foreach ($failure in (Update-SkillJunctions (Join-Path $PSScriptRoot 'skills') (Join-Path $UserHome '.codex\skills'))) { $junctionFailures.Add($failure) }
    foreach ($failure in $junctionFailures) { $failures.Add($failure) }

    if ($failures.Count -gt 0) {
        foreach ($failure in $failures) { Write-Warning $failure }
        throw '同步未全部成功，请处理上方警告后重跑。'
    }

    Write-Host '同步完成：入口符号链接与技能目录联接已维护。'
    if ($ElevatedLogPath) {
        try { Stop-Transcript | Out-Null } catch { }
    }
}
catch {
    if ($ElevatedLogPath) {
        try { Stop-Transcript | Out-Null } catch { }
    }
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
    exit 1
}
