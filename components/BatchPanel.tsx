import React, { useState, useCallback } from 'react';
import type { ClusterInfo, SavedTemplate, ExtractionField } from '../types';
import type { BatchPhase, BatchProgress } from '../hooks/useBatchProcess';
import type { BatchExtractedData, FileManifestEntry } from '../types';
import { Button } from './Button';
import { Card, CardHeader, CardContent } from './Card';
import { ClusterCard } from './ClusterCard';
import { HtmlPreview } from './HtmlPreview';
import { exportJSON, exportTSV, exportTEI, exportMissingFiles } from '../services/exportService';
import { detectStructuralSelectors } from '../services/domExtractionService';

interface BatchPanelProps {
  batchPhase: BatchPhase;
  progress: BatchProgress;
  manifest: FileManifestEntry[];
  missingFiles: FileManifestEntry[];
  clusters: ClusterInfo[];
  batchResults: BatchExtractedData[];
  onLoadAndScan: (
    savedTemplates: SavedTemplate[],
    saveTemplate: (name: string, fingerprint: string, containerSelector: string, fields: ExtractionField[]) => SavedTemplate
  ) => Promise<{ available: number; missing: number; clusters: number }>;
  onAssignTemplate: (clusterId: string, template: SavedTemplate) => void;
  onRunBatchExtraction: () => Promise<void>;
  onCancelBatch: () => void;
  onResetBatch: () => void;
  savedTemplates: SavedTemplate[];
  onSaveNewTemplate: (name: string, fingerprint?: string, containerSelector?: string, fields?: ExtractionField[]) => SavedTemplate;
  onSetFields: (fields: ExtractionField[]) => void;
  onSetContainerSelector: (selector: string) => void;
}

export const BatchPanel: React.FC<BatchPanelProps> = ({
  batchPhase,
  progress,
  manifest,
  missingFiles,
  clusters,
  batchResults,
  onLoadAndScan,
  onAssignTemplate,
  onRunBatchExtraction,
  onCancelBatch,
  onResetBatch,
  savedTemplates,
  onSaveNewTemplate,
  onSetFields,
  onSetContainerSelector,
}) => {
  const [previewCluster, setPreviewCluster] = useState<ClusterInfo | null>(null);
  const [detectingClusterId, setDetectingClusterId] = useState<string | null>(null);

  const handleLoadAndScan = useCallback(async () => {
    await onLoadAndScan(savedTemplates, onSaveNewTemplate);
  }, [onLoadAndScan, savedTemplates, onSaveNewTemplate]);

  const handleAutoDetect = useCallback((cluster: ClusterInfo) => {
    if (!cluster.sampleHtml) return;
    setDetectingClusterId(cluster.id);
    try {
      const suggestion = detectStructuralSelectors(cluster.sampleHtml);
      onSetContainerSelector(suggestion.containerSelector);
      onSetFields([]);
      const template = onSaveNewTemplate(
        cluster.description || `Cluster ${cluster.id.slice(0, 8)}`,
        cluster.fingerprintKey,
        suggestion.containerSelector,
        []
      );
      template.footnoteSelector = suggestion.footnoteSelector;
      onAssignTemplate(cluster.id, template);
    } catch (err) {
      console.error('Auto-detect failed:', err);
    } finally {
      setDetectingClusterId(null);
    }
  }, [onSetContainerSelector, onSetFields, onSaveNewTemplate, onAssignTemplate]);

  const handleSelectForReview = useCallback((cluster: ClusterInfo) => {
    setPreviewCluster(cluster);
  }, []);

  const matchedCount = clusters.filter((c) => c.status === 'matched').length;
  const unmatchedCount = clusters.filter((c) => c.status !== 'matched').length;
  const matchedFileCount = clusters
    .filter((c) => c.status === 'matched')
    .reduce((sum, c) => sum + c.entries.length, 0);

  // Idle state
  if (batchPhase === 'idle') {
    return (
      <Card>
        <CardHeader title="Batch Corpus Processing" subtitle="Process all letter files from the Ben Yehuda corpus" />
        <CardContent className="flex flex-col items-center py-12">
          <p className="text-slate-500 mb-6 text-center max-w-md">
            Load the metadata CSV, scan HTML files for structural patterns,
            and cluster them by template type for batch extraction.
          </p>
          <Button onClick={handleLoadAndScan} size="lg">
            Load Corpus
          </Button>
        </CardContent>
      </Card>
    );
  }

  // Loading / Scanning
  if (batchPhase === 'loading' || batchPhase === 'scanning') {
    const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
    return (
      <Card>
        <CardHeader title="Scanning Corpus" subtitle={progress.phase} />
        <CardContent>
          <div className="w-full bg-slate-100 rounded-full h-3 mb-2">
            <div
              className="bg-indigo-600 h-3 rounded-full transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-sm text-slate-500 text-center">
            {progress.current} / {progress.total} ({pct}%)
          </p>
        </CardContent>
      </Card>
    );
  }

  // Reviewing clusters
  if (batchPhase === 'reviewing') {
    return (
      <div className="space-y-4">
        {/* Summary bar */}
        <Card>
          <CardContent className="py-3">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-4 text-sm">
                <span className="text-slate-700">
                  <strong>{manifest.length}</strong> files in{' '}
                  <strong>{clusters.length}</strong> clusters
                </span>
                {missingFiles.length > 0 && (
                  <span className="text-amber-600">
                    {missingFiles.length} files not found
                  </span>
                )}
                <span className="text-green-600">
                  {matchedCount} matched, {unmatchedCount} need review
                </span>
              </div>
              <div className="flex items-center gap-2">
                {missingFiles.length > 0 && (
                  <Button size="sm" variant="ghost" onClick={() => exportMissingFiles(missingFiles)}>
                    Export Missing
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="primary"
                  disabled={matchedCount === 0}
                  onClick={onRunBatchExtraction}
                >
                  Extract {matchedFileCount} Files
                </Button>
                <Button size="sm" variant="ghost" onClick={onResetBatch}>
                  Reset
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Preview panel */}
        {previewCluster?.sampleHtml && (
          <HtmlPreview
            html={previewCluster.sampleHtml}
            title={`Sample: ${previewCluster.entries[0]?.htmlPath.replace('/corpus/', '') || ''}`}
            onClose={() => setPreviewCluster(null)}
          />
        )}

        {/* Cluster grid */}
        <div className="grid gap-3">
          {clusters.map((cluster) => (
            <ClusterCard
              key={cluster.id}
              cluster={cluster}
              onPreviewSample={setPreviewCluster}
              onAutoDetect={handleAutoDetect}
              onSelectForReview={handleSelectForReview}
              isDetecting={detectingClusterId === cluster.id}
            />
          ))}
        </div>
      </div>
    );
  }

  // Extracting
  if (batchPhase === 'extracting') {
    const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
    const isClassifying = progress.phase.startsWith('Classifying');
    return (
      <Card>
        <CardHeader title="Batch Extraction" subtitle={progress.phase} />
        <CardContent>
          <div className="w-full bg-slate-100 rounded-full h-3 mb-2">
            <div
              className={`h-3 rounded-full transition-all duration-300 ${isClassifying ? 'bg-indigo-600' : 'bg-amber-400'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-sm text-slate-500 text-center mb-1">
            {progress.current} / {progress.total} {isClassifying ? 'units' : 'files'} ({pct}%)
          </p>
          {!isClassifying && (
            <p className="text-xs text-amber-600 text-center mb-3">
              Stage 1: Structural scan (fast)
            </p>
          )}
          {isClassifying && (
            <p className="text-xs text-indigo-600 text-center mb-3">
              Stage 2: Flash classification
            </p>
          )}
          <div className="flex justify-center">
            <Button variant="danger" onClick={onCancelBatch}>
              Cancel &amp; Save Partial
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Done — show results
  if (batchPhase === 'done') {
    // Collect all field names from results
    const fieldNames = new Set<string>();
    batchResults.forEach((r) => Object.keys(r.data).forEach((k) => fieldNames.add(k)));
    const columns = Array.from(fieldNames);

    return (
      <div className="space-y-4">
        <Card>
          <CardContent className="py-3">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-sm text-slate-700">
                  <strong>{batchResults.length}</strong> letters extracted from{' '}
                  <strong>{new Set(batchResults.map((r) => r.sourceFile)).size}</strong> files
                </span>
                <span className="text-xs text-slate-500">
                  Check downloads for <code>e-geret-deferred-files.json</code> if any units were skipped
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="primary" onClick={() => exportJSON(batchResults, missingFiles)}>
                  Export JSON
                </Button>
                <Button size="sm" variant="secondary" onClick={() => exportTSV(batchResults)}>
                  Export TSV
                </Button>
                <Button size="sm" variant="secondary" onClick={() => exportTEI(batchResults)}>
                  Export TEI-XML
                </Button>
                <Button size="sm" variant="ghost" onClick={onResetBatch}>
                  New Batch
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase">
                    Source
                  </th>
                  <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase">
                    #
                  </th>
                  <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase">
                    Title (CSV)
                  </th>
                  {columns.map((col) => (
                    <th
                      key={col}
                      scope="col"
                      className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase"
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {batchResults.slice(0, 200).map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2 text-xs font-mono text-slate-600 whitespace-nowrap">
                      {row.sourceFile}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">{row.letterIndex}</td>
                    <td className="px-3 py-2 text-xs text-slate-600 max-w-[200px] truncate" dir="rtl">
                      {row.csv.title}
                    </td>
                    {columns.map((col) => (
                      <td
                        key={col}
                        className="px-3 py-2 text-xs text-slate-700 max-w-[300px] truncate"
                        dir="rtl"
                      >
                        {row.data[col] || ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {batchResults.length > 200 && (
              <p className="px-3 py-2 text-xs text-slate-500 text-center border-t">
                Showing first 200 of {batchResults.length} results. Use export for full data.
              </p>
            )}
          </div>
        </Card>
      </div>
    );
  }

  return null;
};
