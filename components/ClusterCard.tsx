import React, { useState } from 'react';
import type { ClusterInfo } from '../types';
import { Button } from './Button';

interface ClusterCardProps {
  cluster: ClusterInfo;
  onPreviewSample: (cluster: ClusterInfo) => void;
  onAutoDetect: (cluster: ClusterInfo) => void;
  onSelectForReview: (cluster: ClusterInfo) => void;
  isDetecting?: boolean;
}

export const ClusterCard: React.FC<ClusterCardProps> = ({
  cluster,
  onPreviewSample,
  onAutoDetect,
  onSelectForReview,
  isDetecting,
}) => {
  const [expanded, setExpanded] = useState(false);

  const statusColors = {
    matched: 'bg-green-100 text-green-800 border-green-200',
    unmatched: 'bg-amber-100 text-amber-800 border-amber-200',
    reviewing: 'bg-blue-100 text-blue-800 border-blue-200',
  };

  const statusLabel = {
    matched: `Matched: ${cluster.matchedTemplate?.name || ''}`,
    unmatched: 'Needs Review',
    reviewing: 'Reviewing...',
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="p-4">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-800 truncate">
              {cluster.description}
            </p>
            <p className="text-xs text-slate-500 mt-0.5 font-mono truncate">
              {cluster.fingerprintKey}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-700">
              {cluster.entries.length} files
            </span>
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${statusColors[cluster.status]}`}
            >
              {statusLabel[cluster.status]}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 mt-3">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onPreviewSample(cluster)}
            disabled={!cluster.sampleHtml}
          >
            Preview
          </Button>
          {cluster.status !== 'matched' && (
            <>
              <Button
                size="sm"
                variant="primary"
                onClick={() => onAutoDetect(cluster)}
                isLoading={isDetecting}
                disabled={isDetecting}
              >
                Auto-Detect
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onSelectForReview(cluster)}
              >
                Manual Map
              </Button>
            </>
          )}
        </div>

        {cluster.entries.length > 0 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="mt-2 text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1"
          >
            <span className={`transform transition-transform ${expanded ? 'rotate-90' : ''}`}>
              &#9656;
            </span>
            {expanded ? 'Hide' : 'Show'} file list
          </button>
        )}

        {expanded && (
          <div className="mt-2 max-h-40 overflow-y-auto">
            <ul className="text-xs text-slate-600 space-y-0.5">
              {cluster.entries.map((entry) => (
                <li key={entry.csv.id} className="font-mono truncate">
                  {entry.htmlPath.replace('/corpus/', '')} — {entry.csv.title}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
};
