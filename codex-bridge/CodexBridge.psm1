# CodexBridge - Multi-Agent Collaboration Module
# Enables Claude Code (Opus) to delegate tasks to Codex CLI via file-based handoff + worktree isolation

$script:MODULE_ROOT = $PSScriptRoot

# Inline C# helper for unchecked 32-bit hash (matches JS djb2 with | 0 and >>> 0)
if (-not ([System.Management.Automation.PSTypeName]'CodexBridge.HashHelper').Type) {
    Add-Type -Language CSharp -TypeDefinition @"
namespace CodexBridge {
    public static class HashHelper {
        public static uint Djb2(string s) {
            unchecked {
                int hash = 0;
                foreach (char c in s) {
                    hash = ((hash << 5) - hash) + (int)c;
                }
                return (uint)hash;
            }
        }
    }
}
"@
}

# Reliable git root detection — works regardless of where codex-bridge/ is placed
function script:Get-GitRoot {
    param([string]$FromPath = $script:MODULE_ROOT)
    try {
        Push-Location $FromPath
        $root = git rev-parse --show-toplevel 2>$null
        if ($LASTEXITCODE -eq 0 -and $root) {
            return $root.Trim().Replace('/', '\')
        }
    } catch {} finally { Pop-Location }
    # Fallback: walk up from module root looking for .git
    $dir = $FromPath
    while ($dir) {
        if (Test-Path (Join-Path $dir ".git")) { return $dir }
        $parent = Split-Path $dir -Parent
        if ($parent -eq $dir) { break }
        $dir = $parent
    }
    return $FromPath
}

# Shared sanitization — matches JS sanitizeTaskId() including hash suffix for lossy transforms
function script:ConvertTo-SafeId {
    param([string]$Raw)
    $sanitized = $Raw -replace '[^a-zA-Z0-9_-]', '-'
    if ($sanitized -eq $Raw) { return $sanitized }
    # Append 4-char hex hash to disambiguate (matches JS djb2 with | 0 and >>> 0)
    # Use .NET unchecked arithmetic to match JS 32-bit integer wrapping
    $uhash = [CodexBridge.HashHelper]::Djb2($Raw)
    $hex = $uhash.ToString('x')
    $suffix = if ($hex.Length -gt 4) { $hex.Substring($hex.Length - 4) } else { $hex.PadLeft(4, '0') }
    return "$sanitized-$suffix"
}

# Import sub-modules
. (Join-Path $PSScriptRoot "lib\worktree.ps1")
. (Join-Path $PSScriptRoot "lib\context-builder.ps1")
. (Join-Path $PSScriptRoot "lib\review.ps1")

# Resolve .task-handoff directory (at repo root)
$script:HANDOFF_DIR = Join-Path (Get-GitRoot) ".task-handoff"

# Codex CLI path — lazy-discovered on first use to avoid import-time noise (#12)
$script:CODEX_EXE = $null  # $null = not yet probed; "" = probed but not found

function script:Find-CodexExe {
    # Lazy discovery — runs once, caches result
    if ($null -ne $script:CODEX_EXE) { return $script:CODEX_EXE }
    $candidates = @(
        (Join-Path $env:APPDATA "npm\codex.cmd"),
        (Join-Path $env:APPDATA "npm\codex"),
        "codex"
    )
    foreach ($p in $candidates) {
        if ($p -eq "codex") {
            $found = Get-Command codex -ErrorAction SilentlyContinue
            if ($found) { $script:CODEX_EXE = $found.Source; return $script:CODEX_EXE }
        } else {
            try {
                if (Test-Path $p -ErrorAction SilentlyContinue) {
                    $script:CODEX_EXE = $p; return $script:CODEX_EXE
                }
            } catch {}
        }
    }
    $script:CODEX_EXE = ""
    return ""
}

function Test-CodexAvailable {
    <#
    .SYNOPSIS
    Checks if Codex CLI is installed and available.
    #>
    $ErrorActionPreference = 'Stop'
    $exe = Find-CodexExe
    if (-not $exe) { return $false }
    try {
        if ($exe -match '\.(cmd|bat)$') {
            $ver = & $env:COMSPEC /c "$exe --version" 2>&1
        } else {
            $ver = & $exe --version 2>&1
        }
        if ($LASTEXITCODE -eq 0) {
            Write-Host "[codex-bridge] Codex CLI found: $ver" -ForegroundColor Green
            return $true
        }
    } catch {}
    return $false
}

function Invoke-Codex {
    <#
    .SYNOPSIS
    Delegates a task to Codex CLI, running it in an isolated git worktree.

    .DESCRIPTION
    Full lifecycle:
    1. Creates worktree (if not provided)
    2. Generates task handoff file (if not provided)
    3. Launches Codex in --full-auto mode
    4. Monitors execution with timeout and stale detection
    5. Collects results (exit code, files changed, diff)
    6. Returns structured result hashtable

    .PARAMETER TaskId
    Task identifier from task.json (e.g., "R2-007").

    .PARAMETER Task
    Full task hashtable from task.json. If provided, auto-generates the handoff file.

    .PARAMETER TaskFilePath
    Path to pre-generated handoff file. If omitted, generated from Task parameter.

    .PARAMETER WorktreePath
    Path to existing worktree. If omitted, creates a new one.

    .PARAMETER ProjectRoot
    Root directory of the git repository.

    .PARAMETER TimeoutSeconds
    Hard timeout for Codex execution. Default: 600 (10 minutes).

    .PARAMETER StaleSeconds
    Kill Codex if no output for this many seconds. Default: 120.

    .PARAMETER Model
    Override Codex model. Empty uses Codex default.

    .PARAMETER DryRun
    Only generate the task file, don't execute Codex.

    .PARAMETER ExtraFiles
    Additional source files to include in context.

    .PARAMETER ProjectConfig
    Project configuration hashtable for context builder.

    .OUTPUTS
    Hashtable with: ExitCode, TaskId, Branch, WorktreePath, FilesChanged, DiffSummary, Duration, LogFile, Status
    #>
    param(
        [Parameter(Mandatory)]
        [string]$TaskId,

        [hashtable]$Task = @{},

        [string]$TaskFilePath = "",

        [string]$WorktreePath = "",

        [string]$ProjectRoot = "",

        [int]$TimeoutSeconds = 600,

        [int]$StaleSeconds = 120,

        [string]$Model = "",

        [switch]$DryRun,

        [string[]]$ExtraFiles = @(),

        [hashtable]$ProjectConfig = @{}
    )

    $ErrorActionPreference = 'Stop'

    if (-not $TaskId -or $TaskId.Trim() -eq "") {
        throw "TaskId must not be empty"
    }

    if (-not $ProjectRoot) {
        $ProjectRoot = Get-GitRoot
    }

    # Sanitize TaskId for ALL file/path uses (#11) — uses shared ConvertTo-SafeId
    $safeTaskId = ConvertTo-SafeId $TaskId

    # Ensure handoff directory exists
    if (-not (Test-Path $script:HANDOFF_DIR)) {
        New-Item -ItemType Directory -Path $script:HANDOFF_DIR -Force | Out-Null
    }

    $logFile = Join-Path $script:HANDOFF_DIR "codex-log-$safeTaskId.txt"
    $resultFile = Join-Path $script:HANDOFF_DIR "codex-result-$safeTaskId.json"
    $startTime = Get-Date

    Write-Host ""
    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host "  CODEX BRIDGE - Task: $TaskId" -ForegroundColor Cyan
    Write-Host "============================================" -ForegroundColor Cyan

    # Step 1: Create worktree if needed
    $branch = ""
    if (-not $WorktreePath) {
        Write-Host "[codex-bridge] Creating worktree..." -ForegroundColor Yellow
        $wt = New-CodexWorktree -TaskId $TaskId -ProjectRoot $ProjectRoot
        $WorktreePath = $wt.Path
        $branch = $wt.Branch
    } else {
        $safeName = ConvertTo-SafeId $TaskId
        $branch = "codex/$safeName"
    }

    # Step 2: Generate task file if needed
    if (-not $TaskFilePath) {
        if ($Task.Count -gt 0) {
            Write-Host "[codex-bridge] Generating task handoff file..." -ForegroundColor Yellow
            $TaskFilePath = New-CodexTaskFile `
                -Task $Task `
                -OutputPath (Join-Path $script:HANDOFF_DIR "codex-task-$safeTaskId.md") `
                -ProjectRoot $ProjectRoot `
                -ExtraFiles $ExtraFiles `
                -ProjectConfig $ProjectConfig
        } else {
            throw "Either -Task or -TaskFilePath must be provided"
        }
    }

    # Step 3: DryRun check
    if ($DryRun) {
        Write-Host "[codex-bridge] DryRun mode - task file generated at: $TaskFilePath" -ForegroundColor Cyan
        # Clean up worktree to prevent leak in DryRun mode
        try { Remove-CodexWorktree -TaskId $TaskId -ProjectRoot $ProjectRoot } catch {}
        return @{
            Status       = "dry-run"
            ExitCode     = -1
            TaskId       = $TaskId
            Branch       = $branch
            WorktreePath = $WorktreePath
            TaskFile     = $TaskFilePath
            FilesChanged = @()
            DiffSummary  = ""
            Duration     = 0
            LogFile      = ""
        }
    }

    # Step 4: Verify Codex is available (lazy discovery)
    $codexExe = Find-CodexExe
    if (-not $codexExe) {
        throw "Codex CLI not found. Install with: npm install -g @openai/codex"
    }

    # Step 5: Read task file content for prompt
    $taskContent = Get-Content $TaskFilePath -Raw -Encoding UTF8

    # Step 6: Build Codex command
    $codexArgs = "exec --full-auto"
    if ($Model) {
        # Whitelist validation to prevent command injection via --model parameter
        if ($Model -notmatch '^[a-zA-Z0-9._/-]+$') {
            throw "Invalid model name '$Model' — only alphanumeric, dot, slash, hyphen allowed"
        }
        $codexArgs += " --model $Model"
    }

    # Construct the prompt: tell Codex to read and execute the task
    $prompt = @"
You are working in directory: $WorktreePath

Read and execute the following task specification completely:

$taskContent
"@

    Write-Host "[codex-bridge] Starting Codex (timeout: ${TimeoutSeconds}s, stale: ${StaleSeconds}s)..." -ForegroundColor Yellow

    # Step 7: Launch Codex process
    # .cmd/.bat files need cmd.exe to execute; direct binaries are invoked directly
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    if ($codexExe -match '\.(cmd|bat)$') {
        $psi.FileName = $env:COMSPEC  # cmd.exe
        $psi.Arguments = "/c `"`"$codexExe`" $codexArgs`""
    } else {
        $psi.FileName = $codexExe
        $psi.Arguments = $codexArgs
    }
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = $WorktreePath
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8

    # Set environment for UTF-8
    $psi.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8"
    $psi.EnvironmentVariables["CODEX_QUIET_MODE"] = "1"

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi

    try {
        # Set up async stdout + stderr capture via events (prevents pipe blocking and ReadLineAsync race)
        $stdoutLines = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()
        $stderrLines = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()
        $stdoutHandler = {
            param($sender, $e)
            if ($e.Data) { $stdoutLines.Enqueue($e.Data) }
        }
        $stderrHandler = {
            param($sender, $e)
            if ($e.Data) { $stderrLines.Enqueue($e.Data) }
        }
        $process.add_OutputDataReceived($stdoutHandler)
        $process.add_ErrorDataReceived($stderrHandler)

        $process.Start() | Out-Null

        # Update .codex-pid with actual Codex child process PID (not PS wrapper PID)
        $pidFile = Join-Path $WorktreePath ".codex-pid"
        try { [System.IO.File]::WriteAllText($pidFile, "$($process.Id)", [System.Text.Encoding]::UTF8) } catch {}

        # Begin async reading on BOTH streams before writing stdin (prevents deadlock)
        $process.BeginOutputReadLine()
        $process.BeginErrorReadLine()

        # Write prompt to stdin asynchronously to prevent deadlock on large prompts
        $stdinTask = $process.StandardInput.WriteAsync($prompt)
        $stdinTask.Wait(30000) | Out-Null  # 30s timeout for stdin write
        $process.StandardInput.Close()

        # Step 8: Monitor loop
        $lastOutputAt = Get-Date

        # Initialize log file
        $header = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Codex execution started for task: $TaskId"
        [System.IO.File]::WriteAllText($logFile, "$header`n", [System.Text.Encoding]::UTF8)

        while (-not $process.HasExited) {
            # Drain stdout lines from async queue
            $line = $null
            while ($stdoutLines.TryDequeue([ref]$line)) {
                $lastOutputAt = Get-Date
                [System.IO.File]::AppendAllText($logFile, "$line`n", [System.Text.Encoding]::UTF8)

                # Print condensed output
                if ($line.Length -gt 120) {
                    Write-Host "  [codex] $($line.Substring(0, 117))..." -ForegroundColor DarkGray
                } else {
                    Write-Host "  [codex] $line" -ForegroundColor DarkGray
                }
            }

            # Drain any stderr lines (also counts as activity to prevent stale false-positives)
            $errLine = $null
            while ($stderrLines.TryDequeue([ref]$errLine)) {
                $lastOutputAt = Get-Date
                [System.IO.File]::AppendAllText($logFile, "[STDERR] $errLine`n", [System.Text.Encoding]::UTF8)
                Write-Host "  [codex:err] $errLine" -ForegroundColor DarkYellow
            }

            # Check hard timeout
            $elapsed = ((Get-Date) - $startTime).TotalSeconds
            if ($elapsed -gt $TimeoutSeconds) {
                Write-Host "[codex-bridge] TIMEOUT after ${TimeoutSeconds}s - killing process" -ForegroundColor Red
                try { $process.Kill() } catch {}
                break
            }

            # Check stale timeout
            $idleTime = ((Get-Date) - $lastOutputAt).TotalSeconds
            if ($idleTime -gt $StaleSeconds) {
                Write-Host "[codex-bridge] STALE - no output for ${StaleSeconds}s - killing process" -ForegroundColor Red
                try { $process.Kill() } catch {}
                break
            }

            # Brief sleep to avoid busy-wait
            Start-Sleep -Milliseconds 500
        }

        # Wait for stdout/stderr pipes to close; use timeout to avoid hanging if grandchild holds pipe
        if (-not $process.WaitForExit(5000)) {
            Write-Host "[codex-bridge] WARNING: pipe drain timed out after process exit — grandchild may hold pipe" -ForegroundColor Yellow
        }

        # Drain remaining stdout from async queue
        $line = $null
        while ($stdoutLines.TryDequeue([ref]$line)) {
            [System.IO.File]::AppendAllText($logFile, "$line`n", [System.Text.Encoding]::UTF8)
        }

        # Drain remaining stderr from async queue
        $errLine = $null
        while ($stderrLines.TryDequeue([ref]$errLine)) {
            [System.IO.File]::AppendAllText($logFile, "[STDERR] $errLine`n", [System.Text.Encoding]::UTF8)
        }

        # If process was killed (timeout/stale), ExitCode may be undefined
        try { $exitCode = $process.ExitCode } catch { $exitCode = -1 }
        if ($null -eq $exitCode) { $exitCode = -1 }
        $duration = [math]::Round(((Get-Date) - $startTime).TotalSeconds, 1)

    } catch {
        Write-Host "[codex-bridge] Process error: $_" -ForegroundColor Red
        $exitCode = -1
        $duration = [math]::Round(((Get-Date) - $startTime).TotalSeconds, 1)
        try { [System.IO.File]::AppendAllText($logFile, "[ERROR] Process failed: $_`n", [System.Text.Encoding]::UTF8) } catch {}
    } finally {
        if ($process -and -not $process.HasExited) {
            try { $process.Kill() } catch {}
        }
        try { $process.remove_OutputDataReceived($stdoutHandler) } catch {}
        try { $process.remove_ErrorDataReceived($stderrHandler) } catch {}
        $process.Dispose()
    }

    # Step 9: Auto-commit any uncommitted changes in the worktree
    # Codex may edit files without committing; without this, diff/merge sees nothing
    Write-Host ""
    Write-Host "[codex-bridge] Codex finished. Exit code: $exitCode, Duration: ${duration}s" -ForegroundColor $(if ($exitCode -eq 0) { "Green" } else { "Red" })

    $autoCommitOk = $true
    if (Test-Path $WorktreePath) {
        Push-Location $WorktreePath
        try {
            $uncommitted = git status --porcelain 2>$null
            if ($uncommitted) {
                Write-Host "[codex-bridge] Auto-committing uncommitted Codex changes..." -ForegroundColor Yellow
                # Remove bridge control files before staging to prevent them leaking into merged branches
                git rm -f --cached .codex-pid .codex-blockers.md 2>$null
                git add -A -- . ':!.codex-pid' ':!.codex-blockers.md' 2>$null
                if ($LASTEXITCODE -ne 0) {
                    Write-Host "[codex-bridge] WARNING: git add failed (exit $LASTEXITCODE)" -ForegroundColor Red
                    $autoCommitOk = $false
                } else {
                    git commit -m "[codex/$safeTaskId] Auto-commit Codex working changes" --no-verify 2>$null
                    if ($LASTEXITCODE -ne 0) {
                        Write-Host "[codex-bridge] WARNING: git commit failed (exit $LASTEXITCODE) — changes may be lost" -ForegroundColor Red
                        $autoCommitOk = $false
                    }
                }
            }
        } catch {
            Write-Host "[codex-bridge] WARNING: auto-commit error: $_" -ForegroundColor Red
            $autoCommitOk = $false
        } finally { Pop-Location }
    }

    # Step 10: Collect results
    $filesChanged = @()
    $diffSummary = ""

    try {
        $filesChanged = Get-WorktreeFilesChanged -BranchName $branch -ProjectRoot $ProjectRoot
        $diffSummary = Get-WorktreeDiff -BranchName $branch -ProjectRoot $ProjectRoot -StatOnly
    } catch {
        Write-Host "[codex-bridge] Warning: could not get diff - $($_)" -ForegroundColor Yellow
    }

    $status = "success"
    if ($exitCode -ne 0) { $status = "error" }
    if (((Get-Date) - $startTime).TotalSeconds -ge $TimeoutSeconds) { $status = "timeout" }
    if ($filesChanged.Count -eq 0 -and $exitCode -eq 0) {
        if (-not $autoCommitOk) {
            $status = "commit-failed"
        } else {
            $status = "no-changes"
        }
    }

    $result = @{
        Status       = $status
        ExitCode     = $exitCode
        TaskId       = $TaskId
        Branch       = $branch
        WorktreePath = $WorktreePath
        TaskFile     = $TaskFilePath
        FilesChanged = $filesChanged
        DiffSummary  = $diffSummary
        Duration     = $duration
        LogFile      = $logFile
        Timestamp    = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    }

    # Write result JSON
    $result | ConvertTo-Json -Depth 3 | Set-Content -Path $resultFile -Encoding UTF8
    Write-Host "[codex-bridge] Result saved: $resultFile" -ForegroundColor Cyan

    if ($filesChanged.Count -gt 0) {
        Write-Host "[codex-bridge] Files changed ($($filesChanged.Count)):" -ForegroundColor White
        foreach ($f in $filesChanged | Select-Object -First 10) {
            Write-Host "  - $f" -ForegroundColor Gray
        }
        if ($filesChanged.Count -gt 10) {
            Write-Host "  ... and $($filesChanged.Count - 10) more" -ForegroundColor Gray
        }
    } else {
        Write-Host "[codex-bridge] No files changed" -ForegroundColor Yellow
    }

    Write-Host "============================================" -ForegroundColor Cyan
    Write-Host ""

    return $result
}

# Export public functions
Export-ModuleMember -Function @(
    # Main
    'Invoke-Codex',
    'Test-CodexAvailable',
    # Context
    'New-CodexTaskFile',
    # Worktree
    'New-CodexWorktree',
    'Get-WorktreeDiff',
    'Get-WorktreeFilesChanged',
    'Merge-CodexWorktree',
    'Remove-CodexWorktree',
    'Clear-StaleWorktrees',
    # Review
    'Get-CodexReviewSummary',
    'Format-ReviewForClaude',
    'Complete-CodexTask'
)
