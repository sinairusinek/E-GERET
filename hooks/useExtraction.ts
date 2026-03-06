import { useState, useRef } from 'react';
import { UploadedFile, ExtractionField, ExtractedData, AppStatus } from '../types';
import { suggestTemplateFields, extractMetadata } from '../services/geminiService';
import { extractWithDOM } from '../services/domExtractionService';
import { normalizeDateToISO } from '../services/dateService';

export function useExtraction() {
  const [extractedResults, setExtractedResults] = useState<ExtractedData[]>([]);
  const [status, setStatus] = useState<AppStatus>(AppStatus.IDLE);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const abortRef = useRef<AbortController | null>(null);

  const suggestTemplate = async (sampleHtml: string) => {
    setStatus(AppStatus.GENERATING_TEMPLATE);
    try {
      const suggestion = await suggestTemplateFields(sampleHtml);
      return suggestion;
    } finally {
      setStatus(AppStatus.IDLE);
    }
  };

  const runExtraction = async (
    files: UploadedFile[],
    containerSelector: string,
    fields: ExtractionField[]
  ) => {
    const controller = new AbortController();
    abortRef.current = controller;

    setStatus(AppStatus.EXTRACTING);
    setExtractedResults([]);
    setProgress({ current: 0, total: files.length });

    const allResults: ExtractedData[] = [];

    for (let i = 0; i < files.length; i++) {
      if (controller.signal.aborted) break;
      const file = files[i];
      try {
        // Step 1: Try DOM extraction (instant, no API call)
        const domResult = extractWithDOM(file.content, containerSelector, fields);

        if (domResult.complete) {
          // Step 2a: Try local date normalization
          let needsGemini = false;
          for (const record of domResult.results) {
            if (record['Date'] && !record['DateISO']) {
              const iso = normalizeDateToISO(record['Date']);
              if (iso !== null) {
                record['DateISO'] = iso;
              } else {
                needsGemini = true;
                break;
              }
            }
          }

          if (!needsGemini) {
            // Fully resolved by DOM
            domResult.results.forEach((data, index) => {
              allResults.push({
                id: `${file.id}-${index}`,
                fileId: file.id,
                fileName: file.name,
                letterIndex: index + 1,
                data,
              });
            });
            setProgress({ current: i + 1, total: files.length });
            continue;
          }
        }

        // Step 2b/c: Fall back to Gemini
        const lettersData = await extractMetadata(file, containerSelector, fields, controller.signal);
        lettersData.forEach((data, index) => {
          allResults.push({
            id: `${file.id}-${index}`,
            fileId: file.id,
            fileName: file.name,
            letterIndex: index + 1,
            data
          });
        });
        setProgress({ current: i + 1, total: files.length });
      } catch (err) {
        if (controller.signal.aborted) break;
        console.error("Error processing " + file.name, err);
      }
    }

    abortRef.current = null;
    setExtractedResults(allResults);
    setStatus(allResults.length > 0 ? AppStatus.VIEWING_RESULTS : AppStatus.IDLE);
  };

  const cancelExtraction = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus(AppStatus.IDLE);
  };

  const exportToJson = () => {
    const blob = new Blob([JSON.stringify(extractedResults, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'e_geret_extraction.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const clearResults = () => {
    setExtractedResults([]);
  };

  return {
    extractedResults,
    status,
    progress,
    suggestTemplate,
    runExtraction,
    cancelExtraction,
    exportToJson,
    clearResults,
  };
}
