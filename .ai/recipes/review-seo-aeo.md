# Review Recipe: SEO & AEO Audit

## When to Use

After deploying or significantly changing public-facing pages (landing, blog, marketing pages).
Triggers: changes to `apps/web/`, `apps/*/src/app/`, `public/`, `src/app/`.

## Required Tools

| Tool | Path | Purpose |
|------|------|---------|
| **xihe-rinian-seo** | `.ai/skills/xihe-rinian-seo` | SEO & AEO audit, AI search monitoring, impact reporting |

## Review Process

### Stage 1: Crawl & Baseline

Run the crawler against all public-facing URLs:

```bash
cd .ai/skills/xihe-rinian-seo
node scripts/crawl-page.mjs <URL> --output data/baselines/<project>-<date>.json
```

Minimum URLs to crawl:
- Homepage / Landing page
- Any page with significant content changes

### Stage 2: Technical SEO Checks

From the crawl data, verify:

| Check | Pass Criteria |
|-------|---------------|
| Title tag | Exists, 30-60 chars, contains primary keyword |
| Meta description | Exists, 120-160 chars |
| Canonical URL | Set and correct |
| H1 | Exactly one, contains primary keyword |
| Heading hierarchy | No skipped levels (H1 → H2 → H3) |
| Image alt tags | All images have descriptive alt text |
| robots.txt | Not blocking important pages |
| Sitemap | Exists and is valid |
| hreflang | No duplicates, x-default set (if multilingual) |

### Stage 3: AEO Checks (AI Citability)

| Check | Pass Criteria |
|-------|---------------|
| JSON-LD Schema | At least WebSite + Organization; FAQPage if FAQ exists |
| FAQ content | Semantic `<details>/<summary>` or dt/dd; matches FAQPage Schema |
| llms.txt | Exists at `/llms.txt`, well-formatted |
| AI crawler access | robots.txt allows GPTBot, PerplexityBot, anthropic-ai |
| Answer density | Key facts in first 1-2 sentences, not buried in narrative |
| SSR content | `curl <URL> | grep "<h1>"` returns heading (not JS-only) |

### Stage 4: Lighthouse Cross-Check

Run Google Lighthouse for official SEO score:

```bash
npx lighthouse <URL> --only-categories=seo --output=json --chrome-flags="--headless --no-sandbox"
```

| Check | Pass Criteria |
|-------|---------------|
| Lighthouse SEO | >= 90/100 |
| Structured data | Valid (no errors in Lighthouse) |

### Stage 5: Content Quality

| Check | Pass Criteria |
|-------|---------------|
| Word count | Landing pages >= 500 words SSR; blog posts >= 800 |
| Internal links | >= 5 per page |
| External links | At least 1 authoritative reference |

## Scoring

| Rating | Criteria |
|--------|----------|
| PASS | Lighthouse SEO >= 90, all Stage 2-3 checks green, SSR verified |
| WARN | Lighthouse SEO >= 80, minor AEO gaps (missing llms.txt, incomplete Schema) |
| FAIL | Lighthouse SEO < 80, OR SSR broken (empty headings), OR no Schema at all |

## Output Format

Save the review to `dev/review/seo-aeo-review-<date>.md`:

```markdown
# SEO/AEO Review — <project>
Date: <date>
URLs audited: <list>
Lighthouse SEO: <score>/100
AEO Score: <score>/80

## Results
| Check | Status | Detail |
|-------|--------|--------|
| ... | PASS/WARN/FAIL | ... |

## Issues Found
1. [priority ordered]

## Verdict: PASS / WARN / FAIL
```

## Rules

- SSR is non-negotiable — if crawlers see empty HTML, it's an automatic FAIL
- Schema must match visible content (don't add Schema for content that isn't on the page)
- Don't count JSON-LD Schema content and HTML content as "duplicates" — they should be consistent
- Compare against previous baselines if available to track regression
