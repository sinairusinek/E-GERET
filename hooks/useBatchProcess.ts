import { useState, useRef, useCallback } from 'react';
import type {
  FileManifestEntry,
  ClusterInfo,
  BatchExtractedData,
  SavedTemplate,
  ExtractionField,
  DeferredFile,
} from '../types';
import { loadManifest as loadCSVManifest } from '../services/csvService';
import { computeFingerprint, describeFingerprint, matchFingerprint } from '../services/fingerprintService';
import { classifyLetterText } from '../services/geminiService';
import { extractStructural, detectStructuralSelectors } from '../services/domExtractionService';
import { normalizeDateToISO } from '../services/dateService';
import { exportJSON, exportTSV, exportTEI, exportMissingFiles, exportDeferred } from '../services/exportService';

export type BatchPhase = 'idle' | 'loading' | 'scanning' | 'reviewing' | 'extracting' | 'done';

export interface BatchProgress {
  current: number;
  total: number;
  phase: string;
}

// Concurrency-limited fetch helper
async function fetchConcurrent<T>(
  items: T[],
  fn: (item: T, index: number) => Promise<void>,
  concurrency: number,
  onProgress?: (done: number) => void,
  signal?: AbortSignal
): Promise<void> {
  let nextIndex = 0;
  let doneCount = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      if (signal?.aborted) return;
      const i = nextIndex++;
      await fn(items[i], i);
      doneCount++;
      onProgress?.(doneCount);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
}

export function useBatchProcess() {
  const [manifest, setManifest] = useState<FileManifestEntry[]>([]);
  const [missingFiles, setMissingFiles] = useState<FileManifestEntry[]>([]);
  const [clusters, setClusters] = useState<ClusterInfo[]>([]);
  const [batchResults, setBatchResults] = useState<BatchExtractedData[]>([]);
  const [batchPhase, setBatchPhase] = useState<BatchPhase>('idle');
  const [progress, setProgress] = useState<BatchProgress>({ current: 0, total: 0, phase: '' });
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inProgressResultsRef = useRef<BatchExtractedData[]>([]);
  const missingFilesRef = useRef<FileManifestEntry[]>([]);

  // Store HTML content for loaded files (keyed by htmlPath)
  const htmlCache = useRef<Map<string, string>>(new Map());

  const loadAndScan = useCallback(async (
    savedTemplates: SavedTemplate[],
    saveTemplate: (name: string, fingerprint: string, containerSelector: string, fields: ExtractionField[]) => SavedTemplate
  ) => {
    // Phase 1: Load CSV manifest
    setBatchPhase('loading');
    setProgress({ current: 0, total: 0, phase: 'Loading CSV...' });

    const { entries } = await loadCSVManifest();
    setProgress({ current: 0, total: entries.length, phase: 'Checking file availability...' });

    const controller = new AbortController();
    abortRef.current = controller;

    // Check which files exist
    await fetchConcurrent<FileManifestEntry>(
      entries,
      async (entry) => {
        if (controller.signal.aborted) return;
        try {
          const res = await fetch(entry.htmlPath, { method: 'HEAD' });
          entry.status = res.ok ? 'loaded' : 'missing';
        } catch {
          entry.status = 'missing';
        }
      },
      15,
      (done) => setProgress({ current: done, total: entries.length, phase: 'Checking file availability...' }),
      controller.signal
    );

    const available = entries.filter((e) => e.status === 'loaded');
    const missing = entries.filter((e) => e.status === 'missing');

    setManifest(available);
    setMissingFiles(missing);
    missingFilesRef.current = missing;

    // Phase 2: Fetch HTML and fingerprint
    setBatchPhase('scanning');
    setProgress({ current: 0, total: available.length, phase: 'Fetching & fingerprinting files...' });

    const clusterMap = new Map<string, { entries: FileManifestEntry[]; sampleHtml: string; description: string }>();

    await fetchConcurrent<FileManifestEntry>(
      available,
      async (entry) => {
        if (controller.signal.aborted) return;
        try {
          const res = await fetch(entry.htmlPath);
          if (!res.ok) return;
          const html = await res.text();
          htmlCache.current.set(entry.htmlPath, html);

          const fp = computeFingerprint(html);
          const existing = clusterMap.get(fp.key);
          if (existing) {
            existing.entries.push(entry);
          } else {
            clusterMap.set(fp.key, {
              entries: [entry],
              sampleHtml: html,
              description: describeFingerprint(fp),
            });
          }
        } catch (err) {
          console.warn(`Failed to fetch ${entry.htmlPath}:`, err);
        }
      },
      10,
      (done) => setProgress({ current: done, total: available.length, phase: 'Fetching & fingerprinting files...' }),
      controller.signal
    );

    // Build cluster list
    const clusterList: ClusterInfo[] = [];
    for (const [key, data] of clusterMap) {
      const match = matchFingerprint(key, savedTemplates);
      clusterList.push({
        id: crypto.randomUUID(),
        fingerprintKey: key,
        description: data.description,
        entries: data.entries,
        sampleHtml: data.sampleHtml,
        matchedTemplate: match,
        status: match ? 'matched' : 'unmatched',
      });
    }

    // Sort clusters by file count descending
    clusterList.sort((a, b) => b.entries.length - a.entries.length);

    // Phase 3: Auto-detect structural templates for unmatched clusters (Phase 7)
    const unmatched = clusterList.filter((c) => c.status === 'unmatched' && c.sampleHtml);
    if (unmatched.length > 0) {
      setProgress({ current: 0, total: unmatched.length, phase: 'Auto-detecting templates...' });

      for (let i = 0; i < unmatched.length; i++) {
        if (controller.signal.aborted) break;
        const cluster = unmatched[i];
        try {
          // DOM-based detection: reads heading presence and footnote patterns directly
          // (Gemini was unreliable here — returned "body" even for multi-section files)
          const suggestion = detectStructuralSelectors(cluster.sampleHtml!);
          const template = saveTemplate(
            cluster.description || `Cluster ${cluster.id.slice(0, 8)}`,
            cluster.fingerprintKey,
            suggestion.containerSelector,
            []  // no per-field CSS selectors in structural mode
          );
          template.footnoteSelector = suggestion.footnoteSelector;
          cluster.matchedTemplate = template;
          cluster.status = 'matched';
        } catch (err) {
          console.warn(`Auto-detect failed for cluster ${cluster.id}:`, err);
        }
        setProgress({ current: i + 1, total: unmatched.length, phase: 'Auto-detecting templates...' });
      }
    }

    setClusters(clusterList);
    setBatchPhase('reviewing');

    return { available: available.length, missing: missing.length, clusters: clusterList.length };
  }, []);

  const autoMatchTemplates = useCallback(
    (savedTemplates: SavedTemplate[]) => {
      setClusters((prev) =>
        prev.map((cluster) => {
          const match = matchFingerprint(cluster.fingerprintKey, savedTemplates);
          if (match) {
            return { ...cluster, matchedTemplate: match, status: 'matched' as const };
          }
          return cluster;
        })
      );
    },
    []
  );

  const assignTemplate = useCallback((clusterId: string, template: SavedTemplate) => {
    setClusters((prev) =>
      prev.map((c) =>
        c.id === clusterId
          ? { ...c, matchedTemplate: template, status: 'matched' as const }
          : c
      )
    );
  }, []);

  const runBatchExtraction = useCallback(async () => {
    const matched = clusters.filter((c) => c.status === 'matched' && c.matchedTemplate);
    if (matched.length === 0) return;

    setBatchPhase('extracting');
    const controller = new AbortController();
    abortRef.current = controller;

    // ── PASS 1: DOM STRUCTURAL SWEEP (instant) ──
    interface PendingUnit {
      entry: FileManifestEntry;
      template: SavedTemplate;
      unit: ReturnType<typeof extractStructural>[number];
      clusterId: string;
    }
    const pendingUnits: PendingUnit[] = [];
    let filesScanned = 0;
    const totalFiles = matched.reduce((s, c) => s + c.entries.length, 0);

    setProgress({ current: 0, total: totalFiles, phase: 'Structural scan...' });

    for (const cluster of matched) {
      if (controller.signal.aborted) break;
      const tpl = cluster.matchedTemplate!;

      for (const entry of cluster.entries) {
        if (controller.signal.aborted) break;

        let html = htmlCache.current.get(entry.htmlPath);
        if (!html) {
          try {
            const res = await fetch(entry.htmlPath);
            html = await res.text();
            htmlCache.current.set(entry.htmlPath, html);
          } catch {
            continue;
          }
        }

        const units = extractStructural(html, tpl.containerSelector, tpl.footnoteSelector || '');
        for (const unit of units) {
          pendingUnits.push({ entry, template: tpl, unit, clusterId: cluster.id });
        }

        filesScanned++;
        setProgress({
          current: filesScanned,
          total: totalFiles,
          phase: `Structural scan... (${filesScanned} files, ${pendingUnits.length} units)`,
        });
      }
    }

    console.log(`DOM scan: ${filesScanned} files → ${pendingUnits.length} letter units`);

    // ── PASS 2: FLASH CLASSIFICATION ──
    const TIMEOUT_MS = 30_000;
    const allResults: BatchExtractedData[] = [];
    const deferred: DeferredFile[] = [];
    inProgressResultsRef.current = allResults;

    for (let i = 0; i < pendingUnits.length; i++) {
      if (controller.signal.aborted) break;
      const { entry, template, unit, clusterId } = pendingUnits[i];

      try {
        const timeoutController = new AbortController();
        const timer = setTimeout(() => timeoutController.abort(), TIMEOUT_MS);
        const onAbort = () => timeoutController.abort();
        controller.signal.addEventListener('abort', onAbort, { once: true });

        const classified = await classifyLetterText(
          unit.fullText, unit.footnotes, timeoutController.signal
        );
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', onAbort);

        // Local date normalization fallback if Flash didn't provide DateISO
        if (classified.Date && !classified.DateISO) {
          const iso = normalizeDateToISO(classified.Date);
          if (iso) classified.DateISO = iso;
        }

        allResults.push({
          id: `${entry.csv.id}-${unit.index}`,
          sourceFile: entry.htmlPath.replace('/corpus/', ''),
          csv: entry.csv,
          letterIndex: unit.index + 1,
          data: classified,
          templateName: template.name,
        });

      } catch (err) {
        if (controller.signal.aborted) break;
        deferred.push({
          entry,
          clusterId,
          templateName: template.name,
          reason: (err as Error).name === 'AbortError' ? 'flash-timeout' : 'flash-error',
          error: (err as Error).message,
        });
      }

      setProgress({
        current: i + 1,
        total: pendingUnits.length,
        phase: `Classifying... (${allResults.length} done, ${deferred.length} deferred)`,
      });

      // Silent checkpoint every 20 classified units — no UI, just writes to output folder
      if (allResults.length > 0 && allResults.length % 20 === 0) {
        void fetch('/api/save-file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: 'checkpoint.json',
            content: JSON.stringify({
              savedAt: new Date().toISOString(),
              classified: allResults.length,
              deferred: deferred.length,
              totalUnits: pendingUnits.length,
              results: allResults,
            }, null, 2),
          }),
        });
      }
    }

    // ── FINAL EXPORT ──
    inProgressResultsRef.current = [];
    abortRef.current = null;
    setBatchResults(allResults);
    setBatchPhase('done');

    if (allResults.length > 0) {
      const missing = missingFilesRef.current;
      await Promise.all([
        exportJSON(allResults, missing),
        exportTSV(allResults),
        exportTEI(allResults),
        ...(missing.length > 0 ? [exportMissingFiles(missing)] : []),
      ]);
      console.log(`Saved ${allResults.length} results (${deferred.length} deferred)`);
    }
    if (deferred.length > 0) {
      await exportDeferred(deferred);
      console.log(`Saved ${deferred.length} deferred files`);
    }
  }, [clusters]);

  const cancelBatch = useCallback(() => {
    const partial = [...inProgressResultsRef.current];
    abortRef.current?.abort();
    abortRef.current = null;
    inProgressResultsRef.current = [];
    if (partial.length > 0) {
      setBatchResults(partial);
      setBatchPhase('done');
      const missing = missingFilesRef.current;
      void Promise.all([
        exportJSON(partial, missing),
        exportTSV(partial),
        exportTEI(partial),
      ]).then(() => console.log(`Saved ${partial.length} partial results`));
    } else {
      setBatchPhase('reviewing');
    }
  }, []);

  const resetBatch = useCallback(() => {
    setBatchPhase('idle');
    setManifest([]);
    setMissingFiles([]);
    setClusters([]);
    setBatchResults([]);
    setProgress({ current: 0, total: 0, phase: '' });
    setSelectedClusterId(null);
    htmlCache.current.clear();
    inProgressResultsRef.current = [];
  }, []);

  const getHtmlForEntry = useCallback((htmlPath: string): string | null => {
    return htmlCache.current.get(htmlPath) || null;
  }, []);

  return {
    manifest,
    missingFiles,
    clusters,
    batchResults,
    batchPhase,
    progress,
    selectedClusterId,
    setSelectedClusterId,
    loadAndScan,
    autoMatchTemplates,
    assignTemplate,
    runBatchExtraction,
    cancelBatch,
    resetBatch,
    getHtmlForEntry,
  };
}
