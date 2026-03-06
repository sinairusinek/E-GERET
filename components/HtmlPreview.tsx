import React from 'react';

interface HtmlPreviewProps {
  html: string;
  title?: string;
  onClose?: () => void;
}

export const HtmlPreview: React.FC<HtmlPreviewProps> = ({ html, title, onClose }) => {
  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden bg-white">
      {(title || onClose) && (
        <div className="px-4 py-2 border-b border-slate-100 flex items-center justify-between bg-slate-50">
          <span className="text-sm font-medium text-slate-700">{title || 'HTML Preview'}</span>
          {onClose && (
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600 text-lg leading-none"
              aria-label="Close preview"
            >
              &times;
            </button>
          )}
        </div>
      )}
      <iframe
        srcDoc={html}
        sandbox=""
        className="w-full h-96 border-0"
        title="HTML document preview"
        style={{ direction: 'rtl' }}
      />
    </div>
  );
};
