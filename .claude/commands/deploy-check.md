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


Run deployment readiness checks to verify the project is safe to deploy.

Execute the following command:

```bash
node infra/scripts/health-check.mjs --deploy-ready
```

This runs all standard health checks PLUS:

| Check | What it does |
|-------|-------------|
| **Env vars** | Verifies `.env.production` exists, no placeholder values ("changeme", "TODO") |
| **Secrets scan** | Greps source code for hardcoded API keys, tokens, passwords |
| **Gitignore** | Ensures `.env*`, `*.pem`, `*.key` are in `.gitignore` |
| **Build** | Runs `pnpm build` and verifies output directory exists |
| **Package.json** | Checks name, version, private field, no `file:` dependencies |
| **Legal pages** | If payment enabled: verifies privacy policy, terms of service, support email |

### Common Failures and Fixes

| Failure | Fix |
|---------|-----|
| Missing `.env.production` | Create it with production values, never commit it |
| Hardcoded secret found | Move to environment variable, use `process.env.VAR_NAME` |
| Build failed | Fix build errors first: `pnpm build` |
| Placeholder env values | Replace "changeme"/"TODO" with real values |
| Missing legal pages | Create `/privacy` and `/terms` routes (see payment guide) |
