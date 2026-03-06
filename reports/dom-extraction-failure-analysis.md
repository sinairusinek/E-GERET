# DOM-First Extraction: Failure Analysis Report

**Date:** 2026-03-05
**Run:** Partial extraction, cancelled at 109/430 files (25%)
**Results saved:** 384 letter records from 109 files (auto-exported as JSON + TSV + TEI-XML)

---

## Executive Summary

The DOM-first extraction achieved a **93 DOM / 16 API** split in the first 109 files.
However, after the initial large cluster (77 files, ~95% DOM-only), **every subsequent file
fell through to Gemini API**. At ~2.5 min per Gemini call, completing all 430 files would
take an estimated 5-14 hours.

Root cause analysis identified **three distinct failure categories** affecting 262 of 430 files
(61%). The single largest issue is a **container scoping bug** that is trivially fixable.

---

## Cluster Breakdown (57 clusters, 430 files)

| Category                          | Clusters | Files | % of corpus |
|-----------------------------------|----------|-------|-------------|
| Good (DOM extraction works)       | 16       | 168   | 39%         |
| Head-element scoping bug          | 28       | 133   | 31%         |
| Complex/fragile selectors         | 13       | 129   | 30%         |
| **Total**                         | **57**   | **430** | **100%**  |

---

## Failure Category 1: Head-Element Scoping Bug (28 clusters, 133 files)

### The Bug

When `containerSelector` is `"body"` (or any body-descendant like `"div[dir='rtl']"`),
`extractWithDOM()` sets the container to `doc.body`. Field selectors are then evaluated as
`container.querySelector(selector)`, which searches **only within the body subtree**.

However, `<meta name="author">` and `<title>` live in `<head>`, not `<body>`.
So `doc.body.querySelector('meta[name="author"]')` **always returns null**, the field is
marked incomplete, and the entire file falls back to Gemini.

### Proof

```javascript
const doc = new DOMParser().parseFromString(html, 'text/html');
doc.body.querySelector('meta[name="author"]')  // => null (ALWAYS)
doc.documentElement.querySelector('meta[name="author"]')  // => Element (works)
doc.querySelector('title')  // => Element (works)
```

### Impact

28 clusters totalling 133 files are **guaranteed** to fail DOM extraction because their
templates use `meta[name='author']` or `title` selectors with a body-scoped container.

### Affected Selectors

| Selector pattern           | Clusters using it |
|----------------------------|-------------------|
| `meta[name='author']`      | 26                |
| `title`                    | 19                |
| Both                       | 17                |

### Fix (Trivial)

In `domExtractionService.ts`, when a field selector targets a head-level element,
search from `doc` (the document root) instead of from the container:

```typescript
// Before: always searches within container
const el = container.querySelector(field.selector);

// After: search from doc for head-level selectors
const isHeadSelector = /^(meta|title|link)\b/.test(field.selector.trim());
const searchRoot = isHeadSelector ? doc : container;
const el = searchRoot.querySelector(field.selector);
```

This single change would fix **133 files instantly** (31% of the corpus), with zero API cost.

---

## Failure Category 2: Complex/Fragile Selectors (13 clusters, 129 files)

These clusters have syntactically valid CSS but selectors that may not match across
all files in the cluster, or return incomplete data.

### Sub-category 2a: Comma-Separated Selectors

**Issue:** `querySelector('p, ul')` returns only the **first** matching element.
For a "Content" field this gets only the first paragraph, not all content.

**Impact:** Usually does NOT trigger Gemini fallback (some text is returned),
but extracted data may be truncated. Affects primarily "Content" and "Footnotes" fields.

**Examples:**
- `"p:nth-of-type(2), p:last-of-type"` (18 files)
- `".footnote, .footnotes li"` (15+ files, but Footnotes are excluded from completeness check)
- `"h2 + p, h2 + blockquote + p"` (8 files)
- `"p, ul"`, `"p, blockquote"` (various)

### Sub-category 2b: `:has()` Pseudo-Class

**Issue:** Used in selectors like `p:not(:has(strong:only-child))` and `p:has(strong) + p`.
`:has()` is supported in Chrome 105+ (2022) so it should work in Vite's dev browser,
but it's still a complex selector that may not match all file variants.

**Affected clusters:** 4 clusters, ~52 files

### Sub-category 2c: Over-Specific Positional Selectors

**Issue:** Selectors like `p:nth-of-type(2)`, `body > p:nth-of-type(1)`,
`div[dir='ltr']:nth-of-type(1) p:nth-of-type(1)` are extremely fragile.
If a file has one more or fewer paragraph than the sample used for template detection,
the selector returns the wrong element or nothing.

**Affected clusters:** 5 clusters, ~52 files

### Sub-category 2d: Attribute Substring Matching

**Issue:** `h2[id*='...']` with Hebrew text is very specific to the sample file.

**Affected clusters:** 1 cluster, 8 files

### Fix (Moderate)

These are harder to fix automatically. Options:
1. **Treat comma-separated selectors as multi-match**: use `querySelectorAll` and
   concatenate text from all matches
2. **Add `:has()` fallback**: if `:has()` fails, try without it
3. **For positional selectors**: no automatic fix; would need re-detection or manual review

---

## Successful Category: Good Templates (16 clusters, 168 files)

These clusters use simple, robust selectors that work across all files:
- `h2` for headings/titles
- `p` for content
- `h2 + p` for date/location after heading
- `p strong` for emphasized text
- `.footnotes li` for footnotes
- `body > div[dir="rtl"]` for container scoping

The largest cluster (77 files, "Multi-section with headers, footnotes, heavy emphasis/labels")
accounts for most of the 93 DOM-only extractions in the partial run.

---

## Performance Profile of Partial Run

| Metric                    | Value      |
|---------------------------|------------|
| Files processed           | 109 / 430  |
| DOM-only extractions      | 93 (85%)   |
| Gemini API calls          | 16 (15%)   |
| Letter records extracted  | 384        |
| Avg time per DOM file     | < 50ms     |
| Avg time per Gemini file  | ~2.5 min   |
| Total elapsed time        | ~40 min    |
| Time if all 430 via DOM   | < 30 sec   |
| Projected time at current rate | 5-14 hrs |

---

## Recommended Fix Priority

| Priority | Fix                            | Impact       | Effort   |
|----------|--------------------------------|--------------|----------|
| **P0**   | Head-element scoping bug       | +133 files   | 5 lines  |
| **P1**   | Incremental save + skip logic  | Resilience   | ~100 lines |
| **P2**   | Comma-separated → querySelectorAll | Better data | 10 lines |
| **P3**   | Template quality scoring       | Observability| ~50 lines |

With the P0 fix alone, DOM-only rate would jump from 39% to **~70%** of the corpus.
Combined with P1 (skip+save), the remaining 30% can be deferred to a targeted Gemini phase.

---

## Appendix: All 28 Head-Element Bug Clusters

| # | Description | Files | Affected Fields |
|---|-------------|-------|-----------------|
| 1 | No section headers, few separators | 12 | title, meta[author] |
| 2 | No section headers | 10 | meta[author] |
| 3 | Few section headers, few separators | 10 | meta[author] |
| 4 | No section headers, heavy emphasis/labels, few separators | 9 | meta[author], title |
| 5 | No section headers, footnotes | 9 | title, meta[author] |
| 6 | Few section headers, many separators | 8 | title, meta[author] |
| 7 | No section headers, few separators | 7 | title, meta[author] |
| 8 | Few section headers | 7 | meta[author] |
| 9 | No section headers, footnotes | 6 | title, meta[author] |
| 10 | Few section headers, footnotes, many separators | 6 | meta[author] |
| 11 | Few section headers, footnotes, few separators | 5 | meta[author] |
| 12 | No section headers, footnotes, few separators | 5 | title, meta[author] |
| 13 | Multi-section with headers, heavy emphasis/labels, many separators | 4 | meta[author] |
| 14 | Few section headers, footnotes | 4 | meta[author] |
| 15 | Few section headers, heavy emphasis/labels | 4 | meta[author], title |
| 16 | Few section headers, footnotes, many separators | 4 | meta[author] |
| 17 | Few section headers | 3 | meta[author] |
| 18 | Few section headers, many separators | 3 | meta[author], title |
| 19 | Multi-section with headers, many separators | 3 | meta[author], title |
| 20 | No section headers, footnotes, images/figures, heavy emphasis/labels, many separators | 3 | meta[author], title |
| 21 | Few section headers, footnotes, images/figures, many separators | 2 | title, meta[author] |
| 22 | Few section headers, heavy emphasis/labels, many separators | 2 | meta[author], title |
| 23 | Multi-section with headers | 2 | meta[author], title |
| 24 | Multi-section with headers, many separators | 1 | meta[author], title |
| 25 | No section headers, footnotes, images/figures, heavy emphasis/labels, few separators | 1 | meta[author], title |
| 26 | Multi-section with headers, footnotes, few separators | 1 | meta[author], title |
| 27 | No section headers, footnotes, images/figures | 1 | title, meta[author] |
| 28 | No section headers, footnotes, images/figures, few separators | 1 | title, meta[author] |
