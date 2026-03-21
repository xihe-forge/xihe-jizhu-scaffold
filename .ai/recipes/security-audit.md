# Security Audit Recipe

> Mandatory security review for all projects built on this scaffold.
> Run before every production deployment and after any change to authentication, data access, or dependency versions.

---

## When to Use

- Before merging any PR that touches authentication, authorization, or data access logic
- After any dependency update (especially major versions)
- As a scheduled audit (minimum quarterly) on active projects
- When onboarding a new codebase via `adopt-project.md`

---

## Output Format

Each finding must include:

| Field | Description |
|-------|-------------|
| **Severity** | `CRITICAL` / `HIGH` / `MEDIUM` / `LOW` |
| **Category** | OWASP category (see below) |
| **Location** | `file:line` |
| **Description** | What the issue is and why it is dangerous |
| **Remediation** | Specific steps to fix it |

Aggregate findings at the end with a count per severity. Any `CRITICAL` or `HIGH` finding blocks merging/deployment.

---

## Stage 1: OWASP Top 10 Checks

### A01 — Broken Access Control

- [ ] Every API endpoint that returns or modifies user data checks that the authenticated user owns or has permission for the requested resource (IDOR check)
- [ ] Authorization logic is enforced server-side, never based solely on client-supplied fields (e.g., `role` in a JWT body that is not signed and verified)
- [ ] Admin/privileged routes are protected by a dedicated middleware — grep for `/admin` and `/internal` paths without authorization guards
- [ ] `DELETE`, `PUT`, `PATCH` operations verify resource ownership before acting
- [ ] Directory traversal: file paths derived from user input are sanitized (`path.resolve` + `startsWith` guard)

### A02 — Cryptographic Failures (Sensitive Data Exposure)

- [ ] Passwords are hashed with a modern adaptive algorithm (bcrypt, argon2, scrypt) — never MD5, SHA-1, or plaintext
- [ ] Sensitive fields (SSN, card numbers, health data) are encrypted at rest, not just access-controlled
- [ ] HTTPS is enforced in production: check for `HSTS` header, no `http://` hardcoded URLs
- [ ] PII must not appear in log output — grep for `email`, `password`, `token`, `ssn`, `cardNumber` in logger calls
- [ ] Database connection strings and secrets must not be committed — check `.env.example` only has placeholder values

### A03 — Injection

**SQL / NoSQL:**
- [ ] No string concatenation in query construction — all user input goes through parameterized queries or ORM query builders
- [ ] Grep for raw template literals in SQL: `` `SELECT * FROM ... ${userInput}` ``
- [ ] NoSQL: MongoDB operators (`$where`, `$regex`, arbitrary JSON) are not accepted from user input without validation

**OS Command:**
- [ ] `child_process.exec`, `execSync`, `spawn` with shell: true — grep these; user input must never reach them
- [ ] Use `execFile` (no shell) with an explicit args array when system commands are necessary

**LDAP / XPath / Expression Injection:**
- [ ] Any query language constructed from user input must use escaping or parameterization

### A04 — Insecure Design

- [ ] Password reset flows use short-lived, single-use tokens (max 15 minutes)
- [ ] Account enumeration: login/reset endpoints return the same response regardless of whether the email exists
- [ ] Brute-force protection: account lockout or exponential backoff on failed login attempts

### A05 — Security Misconfiguration

- [ ] No default credentials in any configuration file or seed script
- [ ] Verbose error messages disabled in production (`NODE_ENV=production` suppresses stack traces in responses)
- [ ] Unnecessary HTTP methods disabled (e.g., `TRACE`, `OPTIONS` where not needed)
- [ ] Server/framework version headers suppressed (`X-Powered-By` removed)
- [ ] Development-only endpoints (`/debug`, `/test`, `/seed`) are guarded by environment checks and not reachable in production
- [ ] CORS policy explicitly lists allowed origins — `origin: '*'` is not acceptable for authenticated APIs

### A06 — Vulnerable and Outdated Components

Run dependency scan (see Stage 2). Additionally:

- [ ] Node.js version is within LTS support window
- [ ] No dependencies listed in `package.json` that have been deprecated or abandoned (check npm advisories)
- [ ] `engines` field in `package.json` specifies minimum supported Node version

### A07 — Identification and Authentication Failures

- [ ] JWT secrets are at least 256 bits and stored in environment variables, never hardcoded
- [ ] JWT tokens have an expiry (`exp` claim) — access tokens should be short-lived (15 min – 1 hour)
- [ ] Refresh token rotation is implemented: old token is invalidated on use
- [ ] Session tokens are regenerated after privilege escalation (login, role change)
- [ ] No session fixation: session ID changes on login
- [ ] `HttpOnly` and `Secure` flags set on all authentication cookies
- [ ] `SameSite=Strict` or `SameSite=Lax` on session cookies

### A08 — Software and Data Integrity Failures (Insecure Deserialization)

- [ ] User-supplied JSON is validated against a schema before use (zod, joi, yup, etc.) — never pass raw parsed JSON to business logic
- [ ] No use of `eval`, `new Function()`, `vm.runInNewContext()` with user-supplied strings
- [ ] Serialized objects (cookies, URL params) are signed and the signature is verified before deserialization
- [ ] Webhook payloads are verified via HMAC signature before processing

### A09 — Security Logging and Monitoring Failures

- [ ] Authentication events (login success/failure, logout, password change) are logged with userId and IP
- [ ] Authorization failures (403 responses) are logged — a spike may indicate an attack
- [ ] All logs include a timestamp and request identifier
- [ ] Log integrity: logs are written to an append-only destination; application cannot delete its own logs
- [ ] Alerts exist for: >10 failed logins per minute per IP, >100 4xx responses per minute, any 5xx in production

Refer to `.ai/recipes/error-handling-and-logging.md` for the full logging standard.

### A10 — Server-Side Request Forgery (SSRF)

- [ ] Any feature that fetches a user-supplied URL (webhooks, link previews, import from URL) validates the destination against an allowlist
- [ ] Block requests to private IP ranges: `10.x.x.x`, `172.16–31.x.x`, `192.168.x.x`, `127.x.x.x`, `169.254.x.x` (AWS metadata)
- [ ] Redirect following is disabled or strictly limited when fetching external URLs

### A07-ext — Cross-Site Scripting (XSS)

**Reflected & Stored:**
- [ ] All user-supplied content rendered in HTML is escaped — no raw `innerHTML` with user data
- [ ] React/Vue/Angular template expressions use auto-escaping (no `dangerouslySetInnerHTML` / `v-html` with user input)
- [ ] Grep for `dangerouslySetInnerHTML`, `v-html`, `[innerHTML]`, `document.write` — each instance must be justified and use a sanitizer (DOMPurify)
- [ ] Stored content (comments, profile names, bios) is sanitized at write time AND escaped at render time

**DOM-based:**
- [ ] `location.hash`, `location.search`, `document.referrer` are never passed to `innerHTML`, `eval`, or `document.write`
- [ ] `postMessage` handlers validate `event.origin` before processing data

### XXE — XML External Entities

- [ ] XML parsers have external entity resolution disabled (set `FEATURE_EXTERNAL_GENERAL_ENTITIES` to false)
- [ ] SVG uploads are sanitized — SVGs can contain embedded scripts and XXE payloads
- [ ] If XML parsing is not required, reject `application/xml` content type at the API boundary

---

## Stage 2: Dependency Vulnerability Scanning

Run the appropriate command for the project's package manager:

```bash
# For pnpm projects (default in this scaffold)
pnpm audit --audit-level=moderate

# For npm projects
npm audit --audit-level=moderate

# For yarn projects
yarn audit --level moderate
```

**Triage rules:**

| Severity | Action |
|----------|--------|
| Critical | Block merge/deploy immediately. Upgrade or patch. |
| High | Fix within 24 hours. |
| Moderate | Fix within the current sprint. |
| Low | Track in backlog; fix in next dependency update cycle. |

**License compliance:**

```bash
# Install once: pnpm add -Dw license-checker
npx license-checker --summary --excludePrivatePackages
```

- [ ] No GPL-2.0 or GPL-3.0 licenses in production dependencies of a commercial/proprietary project (they are copyleft and require source disclosure)
- [ ] LGPL is acceptable for linked libraries if not modified
- [ ] AGPL is never acceptable in commercial SaaS (network use triggers copyleft)
- [ ] Flag any `UNKNOWN` license for manual review

---

## Stage 3: Secrets Detection

**Pattern grep — run against the entire source tree (excluding `node_modules`, `.git`, `dist`):**

```bash
# Generic high-entropy strings and common secret patterns
grep -rn --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" \
  --include="*.json" --include="*.yaml" --include="*.yml" --include="*.env*" \
  -E "(api_key|apikey|api-key|secret|password|passwd|token|auth_token|access_token|\
private_key|client_secret|aws_secret|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36}|\
sk-[a-zA-Z0-9]{48}|Bearer [a-zA-Z0-9._-]{20,})" \
  --exclude-dir={node_modules,.git,dist,build,coverage} \
  . 2>/dev/null
```

**Specific checks:**

- [ ] No AWS access key patterns (`AKIA...`) in source files
- [ ] No GitHub tokens (`ghp_...`, `ghs_...`) in source files
- [ ] No OpenAI/Anthropic API keys (`sk-...`) in source files
- [ ] No hardcoded `password` assignments in config files or test fixtures (use environment variable references instead)
- [ ] `.env` files (`.env`, `.env.local`, `.env.production`) are listed in `.gitignore`
- [ ] `.env.example` contains only placeholder values, never real credentials

**Git history scan for accidentally committed secrets:**

```bash
# Search recent 50 commits for secret patterns
git log --all --oneline -50 | while read hash msg; do
  git diff-tree --no-commit-id -r "$hash" -p 2>/dev/null | \
  grep -E "(api_key|secret|password|AKIA[0-9A-Z]{16}|ghp_|sk-)" && \
  echo "  ^^^ Found in commit: $hash $msg"
done
```

If a secret was committed to git history, it must be treated as compromised and rotated immediately. History rewriting alone is insufficient if the repo was ever publicly accessible.

---

## Stage 4: API Security

- [ ] **Rate limiting** is applied to all public-facing endpoints, especially:
  - Authentication endpoints (login, register, password reset): max 5–10 requests/minute per IP
  - Resource-intensive endpoints: max 20–60 requests/minute per user
  - Check for `express-rate-limit`, `@fastify/rate-limit`, or equivalent middleware
- [ ] **CORS** origin whitelist matches the actual production domain(s) — no wildcard `*` on authenticated routes
- [ ] **Input validation** at every API boundary: body, query params, path params, headers — use zod or equivalent
- [ ] Request size limits are set to prevent DoS (`express.json({ limit: '1mb' })`)
- [ ] **Authentication tokens:**
  - Access tokens use short expiry (≤1 hour)
  - Tokens are transmitted via `Authorization: Bearer` header, not URL query parameters
  - Token storage in browser: `HttpOnly` cookies (preferred) or `localStorage` only if XSS risk is fully mitigated
  - Token rotation on refresh: invalidate old token on issue of new token

---

## Stage 5: Frontend Security

- [ ] **Content Security Policy (CSP)** header is set — at minimum:
  ```
  Content-Security-Policy: default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'
  ```
- [ ] **No `innerHTML` with user input** — grep for `innerHTML`, `outerHTML`, `insertAdjacentHTML`; each must use DOMPurify or equivalent
- [ ] **User-generated content** (comments, display names, bio text) is sanitized before storage and HTML-escaped on render
- [ ] **Secure cookie flags**: all cookies set by the application have `HttpOnly`, `Secure`, and `SameSite` attributes
- [ ] **No sensitive data in localStorage**: JWTs, payment tokens, and PII must not be stored in localStorage (accessible by any same-origin JS)
- [ ] **Subresource Integrity (SRI)**: any third-party scripts loaded from a CDN include an `integrity` attribute
- [ ] **`X-Frame-Options: DENY`** or `frame-ancestors 'none'` in CSP to prevent clickjacking
- [ ] **`X-Content-Type-Options: nosniff`** header is set to prevent MIME sniffing

---

## Pass / Fail Criteria

- **PASS**: No CRITICAL or HIGH findings across all 5 stages, dependency audit clean at `moderate` level, no secrets detected
- **CONDITIONAL PASS**: Only MEDIUM/LOW findings — document all findings, create tracked issues, merge allowed
- **FAIL**: Any CRITICAL or HIGH finding → specific remediation required before merge/deploy

---

*Last updated: 2026-03-20*
