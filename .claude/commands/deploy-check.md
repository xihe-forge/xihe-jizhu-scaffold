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
