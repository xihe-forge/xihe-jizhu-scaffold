<!-- GENERATED FILE — edit the .md.tmpl source, then run: pnpm gen:commands -->
You are operating within the xihe-loom-scaffold autonomous delivery system.

## Before You Begin
1. Read `AGENTS.md` for repo rules and delivery standards
2. Read `.planning/STATE.md` for current project status

## Completion Protocol
End your output with exactly one status line:
- `STATUS: DONE` — task completed successfully
- `STATUS: DONE_WITH_CONCERNS` — completed but reviewer should check concerns listed above
- `STATUS: BLOCKED` — cannot proceed, reason stated above
- `STATUS: NEEDS_CONTEXT` — missing information, question stated above

## Skill Paths
When referencing skill files, use the correct submodule paths:
- impeccable skills: `.ai/skills/impeccable/source/skills/<name>/SKILL.md`
- vercel-web-design skills: `.ai/skills/vercel-web-design/skills/<name>/SKILL.md`
- xihe-search-forge skills: `.ai/skills/xihe-search-forge/skills/<name>/SKILL.md`


Run a comprehensive security audit on the project.

Target: $ARGUMENTS (files, directory, or glob pattern — defaults to full project if omitted)

## Audit Steps

### 1. Load Security Recipe

Read and apply every check in `.ai/recipes/security-audit.md` against the target scope.

For each OWASP category in the recipe, examine the relevant source files and report findings in the required format:
- **Severity**: CRITICAL / HIGH / MEDIUM / LOW
- **Category**: OWASP category name
- **Location**: `file:line`
- **Description**: What the issue is and why it is dangerous
- **Remediation**: Specific steps to fix it

### 2. Dependency Vulnerability Scan

Detect the package manager in use, then run the appropriate audit:

```bash
# Detect package manager
if [ -f "pnpm-lock.yaml" ]; then
  pnpm audit --audit-level=moderate 2>&1
elif [ -f "yarn.lock" ]; then
  yarn audit --level moderate 2>&1
else
  npm audit --audit-level=moderate 2>&1
fi
```

Parse and include all reported vulnerabilities as findings. Map audit severity to the recipe severity scale:
- npm/pnpm `critical` → `CRITICAL`
- npm/pnpm `high` → `HIGH`
- npm/pnpm `moderate` → `MEDIUM`
- npm/pnpm `low` → `LOW`

### 3. Secrets Detection

Run a grep scan across source files in the target scope (excluding `node_modules`, `.git`, `dist`, `build`, `coverage`):

```bash
grep -rn \
  --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" \
  --include="*.json" --include="*.yaml" --include="*.yml" \
  -E "(api_key|apikey|api-key|secret_key|client_secret|auth_token|access_token|\
private_key|aws_secret|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36}|\
sk-[a-zA-Z0-9]{48}|Bearer [a-zA-Z0-9._-]{20,}|password\s*=\s*['\"][^'\"]{4,})" \
  --exclude-dir={node_modules,.git,dist,build,coverage} \
  "${TARGET:-.}" 2>/dev/null
```

Also verify:
- `.env` files are listed in `.gitignore`
- `.env.example` (if present) contains only placeholder values

Report each match as a CRITICAL finding under **Category: Secrets Exposure**.

### 4. Output: Structured Findings Report

Present findings grouped by severity, then by category:

```
## Security Audit Report
Target: <target scope>
Date: <today>

### CRITICAL (N findings)
[findings]

### HIGH (N findings)
[findings]

### MEDIUM (N findings)
[findings]

### LOW (N findings)
[findings]

### Summary
| Category         | Critical | High | Medium | Low |
|------------------|----------|------|--------|-----|
| Access Control   |          |      |        |     |
| Injection        |          |      |        |     |
| Secrets Exposure |          |      |        |     |
| Dependencies     |          |      |        |     |
| ...              |          |      |        |     |

Overall result: PASS / CONDITIONAL PASS / FAIL
```

A result of **FAIL** (any CRITICAL or HIGH) must block merging or deployment until all blocking findings are remediated.
