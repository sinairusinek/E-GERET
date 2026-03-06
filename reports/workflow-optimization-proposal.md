# Workflow Optimization: Incremental Save + Skip-and-Defer

**Date:** 2026-03-05
**Context:** DOM-first extraction stalls when clusters need Gemini fallback (~2.5 min/file).
Partial results are only saved on cancel/completion. If the tab crashes, everything is lost.

---

## Problem Statement

The current `runBatchExtraction` in `useBatchProcess.ts` has three weaknesses:

1. **All-or-nothing saving:** Results accumulate in-memory and are only exported on
   completion or cancel. A browser crash loses all progress.

2. **No per-cluster timeout or skip:** A cluster with 18 files all needing Gemini blocks
   the pipeline for ~45 minutes. There's no way to skip it and come back later.

3. **No separation of fast (DOM) vs slow (API) work:** DOM-only files complete in
   milliseconds but are interleaved with multi-minute Gemini calls.

---

## Proposed Architecture: Three-Phase Pipeline

### Phase A: DOM-Only Sweep (seconds)

Process ALL files across ALL clusters using DOM extraction only. Skip any file where
DOM extraction is incomplete (don't call Gemini). Save results incrementally.

```
For each cluster:
  For each file in cluster:
    result = extractWithDOM(html, template)
    if (result.complete):
      append to domResults[]
      if domResults.length % SAVE_INTERVAL == 0:
        incrementalSave(domResults)
    else:
      append to deferredFiles[] with { file, cluster, template, reason }

Export domResults immediately
Export deferredFiles manifest as "deferred-for-gemini.json"
```

**Expected outcome:** ~70% of files (after P0 fix) extracted in under 30 seconds.
Incremental saves every N files mean zero data loss risk.

### Phase B: Targeted Gemini Phase (minutes-hours)

Process only the deferred files from Phase A, with per-file timeout and skip logic.

```
For each deferredFile:
  try:
    result = await extractMetadata(file, template, signal) with TIMEOUT
    append to geminiResults[]
    incrementalSave(geminiResults)
  catch (timeout or error):
    append to failedFiles[] with { file, error, duration }
    continue (don't block)

Export geminiResults
Export failedFiles manifest as "failed-extraction.json"
```

**Key features:**
- Per-file timeout (e.g., 3 minutes) — skip and log if exceeded
- Incremental save after each successful Gemini extraction
- Failed files logged with error details for manual review

### Phase C: Manual Review (optional)

The `failed-extraction.json` from Phase B can be reviewed to:
- Fix templates (bad selectors)
- Retry with adjusted parameters
- Mark as "not extractable" and exclude

---

## Implementation: Specific Code Changes

### 1. Incremental Save Helper

New function in `exportService.ts`:

```typescript
export function incrementalSaveJSON(
  results: BatchExtractedData[],
  phase: 'dom' | 'gemini' | 'merged',
  missingFiles: FileManifestEntry[]
): void {
  const output = {
    phase,
    savedAt: new Date().toISOString(),
    results: results.map(r => ({
      id: r.id,
      letterIndex: r.letterIndex,
      sourceFile: r.sourceFile,
      templateUsed: r.templateName,
      csvMetadata: r.csv,
      extracted: r.data,
    })),
    summary: {
      totalLettersExtracted: results.length,
      totalFiles: new Set(results.map(r => r.sourceFile)).size,
    },
  };

  const blob = new Blob(
    [JSON.stringify(output, null, 2)],
    { type: 'application/json' }
  );
  downloadBlob(blob, `e-geret-${phase}-checkpoint.json`);
}
```

### 2. Deferred Files Manifest

New type in `types.ts`:

```typescript
export interface DeferredFile {
  entry: FileManifestEntry;
  clusterId: string;
  templateName: string;
  containerSelector: string;
  fields: ExtractionField[];
  reason: 'dom-incomplete' | 'dom-error' | 'gemini-timeout' | 'gemini-error';
  incompleteFields?: string[];
}
```

### 3. Modified `runBatchExtraction` — Two-Pass Architecture

Replace the single loop with two passes:

```typescript
const runBatchExtraction = useCallback(async () => {
  // === PASS 1: DOM-only sweep (fast) ===
  setBatchPhase('extracting');
  const domResults: BatchExtractedData[] = [];
  const deferred: DeferredFile[] = [];
  let domCount = 0;

  for (const cluster of matchedClusters) {
    const template = cluster.matchedTemplate!;
    for (const entry of cluster.entries) {
      const html = await getOrFetchHtml(entry);
      const domResult = extractWithDOM(html, template.containerSelector, template.fields);

      if (domResult.complete && allDatesResolved(domResult)) {
        pushResults(domResults, entry, domResult, template);
        domCount++;
      } else {
        deferred.push({
          entry, clusterId: cluster.id,
          templateName: template.name,
          containerSelector: template.containerSelector,
          fields: template.fields,
          reason: 'dom-incomplete',
          incompleteFields: domResult.incompleteFields,
        });
      }
    }
  }

  // Checkpoint: save DOM results immediately
  if (domResults.length > 0) {
    incrementalSaveJSON(domResults, 'dom', missingFilesRef.current);
  }
  exportDeferredManifest(deferred); // Save what still needs Gemini

  // === PASS 2: Gemini for deferred files (slow, with timeout) ===
  const GEMINI_TIMEOUT_MS = 180_000; // 3 minutes per file
  const geminiResults: BatchExtractedData[] = [];
  const failed: DeferredFile[] = [];

  for (const item of deferred) {
    if (controller.signal.aborted) break;

    try {
      const html = await getOrFetchHtml(item.entry);
      const file = toUploadedFile(item.entry, html);
      const timeoutSignal = AbortSignal.timeout(GEMINI_TIMEOUT_MS);
      const combinedSignal = combineSignals(controller.signal, timeoutSignal);

      const lettersData = await extractMetadata(
        file, item.containerSelector, item.fields, combinedSignal
      );
      pushGeminiResults(geminiResults, item.entry, lettersData, item.templateName);

      // Incremental save after each successful Gemini call
      incrementalSaveJSON([...domResults, ...geminiResults], 'merged', missingFilesRef.current);
    } catch (err) {
      if (controller.signal.aborted) break;
      failed.push({ ...item, reason: isTimeout(err) ? 'gemini-timeout' : 'gemini-error' });
    }
  }

  // Final export
  exportAll([...domResults, ...geminiResults], missingFilesRef.current);
  if (failed.length > 0) exportFailedManifest(failed);
}, [clusters]);
```

### 4. Head-Element Scoping Fix (P0)

In `domExtractionService.ts`, line 98:

```typescript
// Current (broken for meta/title):
const el = container.querySelector(field.selector);

// Fixed:
const selectorTrimmed = field.selector.trim();
const isHeadSelector = /^(meta|title|link)\b/.test(selectorTrimmed);
const searchRoot = isHeadSelector ? doc : container;
const el = searchRoot.querySelector(selectorTrimmed);
```

### 5. Comma-Separated Selector Enhancement (P2)

For fields where we want concatenated text from multiple selectors:

```typescript
// If selector contains commas, use querySelectorAll and join text
if (field.selector.includes(',')) {
  const els = Array.from(container.querySelectorAll(field.selector));
  const text = els.map(el => el.textContent?.trim()).filter(Boolean).join('\n');
  record[field.name] = text;
} else {
  const el = container.querySelector(field.selector);
  record[field.name] = el?.textContent?.trim() || '';
}
```

---

## Incremental Save Strategy

| Event                        | What is saved                          | Filename                       |
|------------------------------|----------------------------------------|--------------------------------|
| Every N DOM files (N=50)     | All DOM results so far                 | `e-geret-dom-checkpoint.json`  |
| After DOM sweep completes    | All DOM results + deferred manifest    | `e-geret-dom-checkpoint.json` + `e-geret-deferred.json` |
| After each Gemini success    | Merged DOM + Gemini results            | `e-geret-merged-checkpoint.json` |
| On completion                | Final full export (JSON + TSV + TEI)   | `e-geret-batch-export.*`       |
| On cancel                    | Whatever we have so far                | `e-geret-partial-export.*`     |
| On failure                   | Failed files manifest                  | `e-geret-failed-extraction.json` |

---

## Expected Performance After Fixes

| Scenario                     | DOM files | Gemini files | Est. time    |
|------------------------------|-----------|--------------|--------------|
| Current (no fix)             | 168 (39%) | 262 (61%)    | 5-14 hours   |
| After P0 (head-element fix)  | 301 (70%) | 129 (30%)    | 30s + ~5 hrs |
| After P0 + P2 (comma fix)   | ~330 (77%)| ~100 (23%)   | 30s + ~4 hrs |
| After P0, DOM sweep only     | 301 (70%) | 0 (skipped)  | **< 30 sec** |

The two-phase approach means you get **70% of results in 30 seconds**, then can
decide whether to run the slow Gemini phase or defer it.

---

## Migration Path

1. **Apply P0 fix** (head-element scoping) — 5 lines in `domExtractionService.ts`
2. **Clear old templates** from localStorage (they'll be auto-regenerated)
3. **Re-run batch** — verify ~70% DOM-only rate
4. **Implement incremental save** — modify `useBatchProcess.ts` and `exportService.ts`
5. **Implement skip+defer** — add timeout, deferred manifest, two-pass loop
6. **Apply P2 fix** (comma selectors) — 10 lines in `domExtractionService.ts`
7. **Re-run** — handle remaining deferred files in targeted Gemini phase

---

## File Changes Summary

| File                           | Change type | Lines |
|--------------------------------|-------------|-------|
| `services/domExtractionService.ts` | Bug fix (P0 + P2) | ~15 |
| `services/exportService.ts`    | Add incremental save + deferred/failed export | ~60 |
| `hooks/useBatchProcess.ts`     | Two-pass architecture + timeout + incremental save | ~100 |
| `types.ts`                     | Add `DeferredFile` type | ~10 |
| **Total**                      |             | **~185 lines** |
