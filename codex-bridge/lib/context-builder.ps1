# Codex Bridge - Context Builder
# Builds self-contained task handoff files for Codex

$script:MAX_CONTEXT_BYTES = 50 * 1024  # 50KB cap for relevant files section
$script:TEMPLATE_PATH = Join-Path (Split-Path $PSScriptRoot -Parent) "templates\codex-task-template.md"

# Denylist: files matching these patterns are never included in handoff context
$script:SECRET_DENYLIST = @(
    '\.env$', '\.env\..+$',
    'credentials\.json$', 'secrets\.json$', 'service-account.*\.json$',
    '\.pem$', '\.key$', '\.p12$', '\.pfx$',
    'id_rsa$', 'id_ed25519$', '\.ssh[\\/]',
    'token\.json$', 'auth\.json$',
    '\.npmrc$', '\.pypirc$',
    'kubeconfig$'
)

# PowerShell 5.1 compatible null-coalesce helper
function script:Coalesce { foreach ($arg in $args) { if ($arg) { return $arg } }; return "" }

function New-CodexTaskFile {
    <#
    .SYNOPSIS
    Generates a self-contained task handoff file for Codex.
    .PARAMETER Task
    Hashtable representing a task from task.json.
    .PARAMETER OutputPath
    Where to write the generated .md file.
    .PARAMETER ProjectRoot
    Root of the project (for reading source files).
    .PARAMETER ExtraFiles
    Additional file paths to include as context.
    .PARAMETER ProjectConfig
    Hashtable with project-specific config (tech_stack, conventions, structure).
    .OUTPUTS
    Path to the generated task file.
    #>
    param(
        [Parameter(Mandatory)]
        [hashtable]$Task,

        [string]$OutputPath = "",

        [string]$ProjectRoot = "",

        [string[]]$ExtraFiles = @(),

        [hashtable]$ProjectConfig = @{}
    )

    if (-not $ProjectRoot) {
        $ProjectRoot = Get-GitRoot
    }

    # Default output path — sanitize Task.id for safe filesystem use
    if (-not $OutputPath) {
        $handoffDir = Join-Path (Get-GitRoot) ".task-handoff"
        if (-not (Test-Path $handoffDir)) {
            New-Item -ItemType Directory -Path $handoffDir -Force | Out-Null
        }
        $safeId = ConvertTo-SafeId $Task.id
        $OutputPath = Join-Path $handoffDir "codex-task-$safeId.md"
    }

    # Load template
    $template = Get-Content $script:TEMPLATE_PATH -Raw -Encoding UTF8

    # Resolve project config with defaults
    $config = Resolve-ProjectConfig -ProjectConfig $ProjectConfig -ProjectRoot $ProjectRoot

    # Build relevant files section
    $relevantFiles = Get-RelevantFiles -Task $Task -ProjectRoot $ProjectRoot -ExtraFiles $ExtraFiles
    $filesSection = Format-FilesSection -Files $relevantFiles -ProjectRoot $ProjectRoot

    # Format task steps
    $steps = ""
    if ($Task.steps) {
        $steps = ($Task.steps | ForEach-Object { "- $_" }) -join "`n"
    }

    # Format acceptance criteria
    $criteria = ""
    if ($Task.acceptance_criteria) {
        $criteria = ($Task.acceptance_criteria | ForEach-Object { "- $_" }) -join "`n"
    }

    # Replace template placeholders — use .Replace() not -replace to avoid regex meta-chars (#13)
    $content = $template
    $content = $content.Replace('{{TASK_ID}}', (Coalesce $Task.id "UNKNOWN"))
    $content = $content.Replace('{{TASK_NAME}}', (Coalesce $Task.name "Untitled Task"))
    $content = $content.Replace('{{PROJECT_NAME}}', (Coalesce $config.project_name "Project"))
    $content = $content.Replace('{{TECH_STACK}}', (Coalesce $config.tech_stack "Not specified"))
    $content = $content.Replace('{{PROJECT_STRUCTURE}}', (Coalesce $config.structure "See source files below"))
    $content = $content.Replace('{{CONVENTIONS}}', (Coalesce $config.conventions "Follow existing code patterns"))
    $content = $content.Replace('{{TASK_TYPE}}', (Coalesce $Task.type "implementation"))
    $content = $content.Replace('{{TASK_PRIORITY}}', (Coalesce $Task.priority "P1"))
    $content = $content.Replace('{{TASK_DESCRIPTION}}', (Coalesce $Task.description $Task.name ""))
    $content = $content.Replace('{{TASK_STEPS}}', $steps)
    $content = $content.Replace('{{ACCEPTANCE_CRITERIA}}', $criteria)
    $content = $content.Replace('{{RELEVANT_FILES}}', $filesSection)

    # Write output
    [System.IO.File]::WriteAllText($OutputPath, $content, [System.Text.Encoding]::UTF8)
    Write-Host "[context] Generated task file: $OutputPath" -ForegroundColor Green

    return $OutputPath
}

function Resolve-ProjectConfig {
    <#
    .SYNOPSIS
    Resolves project configuration from explicit config or auto-detection.
    #>
    param(
        [hashtable]$ProjectConfig,
        [string]$ProjectRoot
    )

    $config = @{
        project_name = if ($ProjectConfig.project_name) { $ProjectConfig.project_name } else { "" }
        tech_stack   = if ($ProjectConfig.tech_stack) { $ProjectConfig.tech_stack } else { "" }
        structure    = if ($ProjectConfig.structure) { $ProjectConfig.structure } else { "" }
        conventions  = if ($ProjectConfig.conventions) { $ProjectConfig.conventions } else { "" }
    }

    # Auto-detect from package.json if not provided
    if (-not $config.project_name -or -not $config.tech_stack) {
        # Search for package.json in project root and immediate subdirectories
        $packageJsonPaths = @((Join-Path $ProjectRoot "package.json"))
        $packageJsonPaths += Get-ChildItem -Path $ProjectRoot -Directory -Depth 1 -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName "package.json" } |
            Where-Object { Test-Path $_ }

        foreach ($pjPath in $packageJsonPaths) {
            if (Test-Path $pjPath) {
                try {
                    $pj = Get-Content $pjPath -Raw -Encoding UTF8 | ConvertFrom-Json
                    if (-not $config.project_name -and $pj.name) {
                        $config.project_name = $pj.name
                    }
                } catch {}
                break
            }
        }
    }

    # Defaults
    if (-not $config.project_name) { $config.project_name = Split-Path $ProjectRoot -Leaf }
    if (-not $config.tech_stack) {
        $config.tech_stack = "Auto-detect from project files"
    }
    if (-not $config.structure) {
        $config.structure = "See project directory structure"
    }
    if (-not $config.conventions) {
        $config.conventions = "Follow existing code patterns in the codebase"
    }

    return $config
}

function Get-RelevantFiles {
    <#
    .SYNOPSIS
    Determines which source files are relevant to the task.
    Uses heuristics based on task description, type, and name.
    #>
    param(
        [hashtable]$Task,
        [string]$ProjectRoot,
        [string[]]$ExtraFiles = @()
    )

    $files = [System.Collections.Generic.List[string]]::new()

    # 1. Add explicitly provided extra files (must be under ProjectRoot #7)
    # Append trailing '\' to prevent prefix collisions (C:\repo matching C:\repo2)
    $normalizedRoot = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\', '/') + '\'
    foreach ($f in $ExtraFiles) {
        if (Test-Path $f) {
            $absPath = [System.IO.Path]::GetFullPath($f)
            if ($absPath.StartsWith($normalizedRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
                $absPath -eq $normalizedRoot.TrimEnd('\')) {
                $files.Add($absPath)
            } else {
                Write-Host "[context] BLOCKED out-of-repo file: $f" -ForegroundColor Red
            }
        }
    }

    # 2. Parse task description and steps for file/path mentions
    $descText = if ($Task.description) { $Task.description } else { "" }
    $nameText = if ($Task.name) { $Task.name } else { "" }
    $stepsText = if ($Task.steps) { $Task.steps -join " " } else { "" }
    $textToScan = "$descText $nameText $stepsText"

    # Match patterns like: apps/web/src/..., packages/types/..., src/...
    $pathPattern = '(?:apps|packages|src)/[\w/.-]+'
    $pathMatches = [regex]::Matches($textToScan, $pathPattern)
    # Resolve root for containment check (trailing '\' to prevent prefix collision)
    $absRoot = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\', '/') + '\'
    foreach ($m in $pathMatches) {
        $candidatePath = Join-Path $ProjectRoot $m.Value
        # Resolve to absolute path to neutralize ../.. traversal
        $resolvedCandidate = [System.IO.Path]::GetFullPath($candidatePath)
        if (-not $resolvedCandidate.StartsWith($absRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            Write-Host "[context] BLOCKED path traversal attempt: $($m.Value)" -ForegroundColor Red
            continue
        }
        # Try exact match first
        if (Test-Path $resolvedCandidate) {
            $files.Add($resolvedCandidate)
        }
        # Try with common extensions
        foreach ($ext in @(".ts", ".tsx", ".js", ".jsx")) {
            $withExt = "$resolvedCandidate$ext"
            if (Test-Path $withExt) { $files.Add($withExt) }
        }
    }

    # 3. Type-based heuristics
    $taskNameLower = $nameText.ToLower()

    # Find project base: check $ProjectRoot itself first, then child directories
    $projBase = $null
    if (Test-Path (Join-Path $ProjectRoot "package.json") -or Test-Path (Join-Path $ProjectRoot "apps")) {
        $projBase = $ProjectRoot
    } else {
        $projectDirs = Get-ChildItem -Path $ProjectRoot -Directory |
            Where-Object { Test-Path (Join-Path $_.FullName "package.json") -or Test-Path (Join-Path $_.FullName "apps") } |
            Select-Object -First 1
        if ($projectDirs) { $projBase = $projectDirs.FullName }
    }

    if ($projBase) {

        # If task mentions "entity" or "model", include types
        if ($taskNameLower -match 'entity|model|type|schema') {
            $typesDir = Join-Path $projBase "packages\types\src"
            if (Test-Path $typesDir) {
                $typeFiles = Get-ChildItem -Path $typesDir -Filter "*.ts" -Recurse -ErrorAction SilentlyContinue
                foreach ($tf in $typeFiles) { $files.Add($tf.FullName) }
            }
        }

        # If task mentions "service", include related service files
        if ($taskNameLower -match 'service') {
            $servicesDir = Join-Path $projBase "apps\api\src\services"
            if (Test-Path $servicesDir) {
                $serviceFiles = Get-ChildItem -Path $servicesDir -Filter "*.ts" -Recurse -ErrorAction SilentlyContinue
                foreach ($sf in $serviceFiles | Select-Object -First 5) { $files.Add($sf.FullName) }
            }
        }

        # If task mentions "component" or "page", include related frontend files
        if ($taskNameLower -match 'component|page|ui|frontend') {
            $webDir = Join-Path $projBase "apps\web\src"
            if (Test-Path $webDir) {
                $compFiles = Get-ChildItem -Path $webDir -Filter "*.tsx" -Recurse -ErrorAction SilentlyContinue
                foreach ($cf in $compFiles | Select-Object -First 5) { $files.Add($cf.FullName) }
            }
        }
    }

    # 4. Deduplicate (case-insensitive for Windows paths)
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $unique = [System.Collections.Generic.List[string]]::new()
    foreach ($f in $files) {
        $normalized = [System.IO.Path]::GetFullPath($f)
        if ($seen.Add($normalized)) {
            $unique.Add($normalized)
        }
    }

    return @($unique)
}

function Format-FilesSection {
    <#
    .SYNOPSIS
    Formats the relevant files section of the handoff document.
    Respects the MAX_CONTEXT_BYTES limit.
    #>
    param(
        [string[]]$Files,
        [string]$ProjectRoot
    )

    if (-not $Files -or $Files.Count -eq 0) {
        return "*No specific files identified. Explore the project structure to understand the codebase.*"
    }

    $sb = [System.Text.StringBuilder]::new()
    $totalBytes = 0

    foreach ($filePath in $Files) {
        if (-not (Test-Path $filePath)) { continue }

        $fileInfo = Get-Item $filePath
        # Case-insensitive path prefix removal for Windows
        $absFile = [System.IO.Path]::GetFullPath($filePath)
        $absRoot = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\', '/')
        if ($absFile.StartsWith($absRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            $relativePath = $absFile.Substring($absRoot.Length).TrimStart('\', '/')
        } else {
            $relativePath = $absFile
        }

        # Skip secret/sensitive files
        $isDenied = $false
        foreach ($pattern in $script:SECRET_DENYLIST) {
            if ($relativePath -match $pattern) {
                $isDenied = $true
                Write-Host "[context] BLOCKED secret file: $relativePath" -ForegroundColor Red
                break
            }
        }
        if ($isDenied) { continue }

        # Skip very large files
        if ($fileInfo.Length -gt 20 * 1024) {
            [void]$sb.AppendLine("### $relativePath")
            [void]$sb.AppendLine("*(File too large: $([math]::Round($fileInfo.Length / 1024, 1))KB - read from disk)*")
            [void]$sb.AppendLine("")
            continue
        }

        $content = Get-Content $filePath -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
        if (-not $content) { continue }

        $contentBytes = [System.Text.Encoding]::UTF8.GetByteCount($content)

        # Check cap
        if ($totalBytes + $contentBytes -gt $script:MAX_CONTEXT_BYTES) {
            [void]$sb.AppendLine("### $relativePath")
            [void]$sb.AppendLine("*(Skipped: context size limit reached)*")
            [void]$sb.AppendLine("")
            continue
        }

        $totalBytes += $contentBytes

        $ext = $fileInfo.Extension.TrimStart(".")
        if (-not $ext) { $ext = "text" }

        [void]$sb.AppendLine("### $relativePath")
        [void]$sb.AppendLine("``````$ext")
        [void]$sb.AppendLine($content.TrimEnd())
        [void]$sb.AppendLine("``````")
        [void]$sb.AppendLine("")
    }

    return $sb.ToString().TrimEnd()
}
