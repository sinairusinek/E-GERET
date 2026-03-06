
export interface UploadedFile {
  id: string;
  name: string;
  content: string;
  size: number;
  type: string;
}

export interface ExtractionField {
  id: string;
  name: string;
  description: string;
  selector?: string;
}

export interface SavedTemplate {
  id: string;
  name: string;
  containerSelector: string;
  fields: ExtractionField[];       // kept for manual mode / legacy
  createdAt: number;
  fingerprint?: string;
  footnoteSelector?: string;       // for structural-only batch mode
}

export interface ExtractedData {
  id: string;
  fileId: string;
  fileName: string;
  letterIndex: number;
  data: Record<string, string>;
}

export enum AppStatus {
  IDLE = 'IDLE',
  UPLOADING = 'UPLOADING',
  GENERATING_TEMPLATE = 'GENERATING_TEMPLATE',
  EXTRACTING = 'EXTRACTING',
  VIEWING_RESULTS = 'VIEWING_RESULTS',
  BATCH_SCANNING = 'BATCH_SCANNING',
  BATCH_REVIEWING = 'BATCH_REVIEWING',
  BATCH_EXTRACTING = 'BATCH_EXTRACTING',
}

export interface CsvMetadata {
  id: number;
  title: string;
  authorString: string;
  authorIds: number[];
  origLang: string;
  origPublicationDate: string;
  period: string;
  intellectualProperty: string;
  url: string;
}

export interface FileManifestEntry {
  csv: CsvMetadata;
  htmlPath: string;
  status: 'pending' | 'loaded' | 'missing';
}

export interface ClusterInfo {
  id: string;
  fingerprintKey: string;
  description: string;
  entries: FileManifestEntry[];
  sampleHtml: string | null;
  matchedTemplate: SavedTemplate | null;
  status: 'unmatched' | 'matched' | 'reviewing';
}

export interface BatchExtractedData {
  id: string;
  sourceFile: string;
  csv: CsvMetadata;
  letterIndex: number;
  data: Record<string, string>;
  templateName: string;
}

/** Simplified template for structural-only extraction */
export interface StructuralTemplate {
  id: string;
  name: string;
  containerSelector: string;
  footnoteSelector: string;
  fingerprint?: string;
  createdAt: number;
}

/** Fields returned by Flash classification (fixed set, not template-specific) */
export const SEMANTIC_FIELDS = [
  'Recipient', 'Sender', 'Date', 'DateISO', 'Location',
  'Content', 'Signature', 'Footnotes'
] as const;
export type SemanticFieldName = typeof SEMANTIC_FIELDS[number];

/** A deferred file that needs retry or manual review */
export interface DeferredFile {
  entry: FileManifestEntry;
  clusterId: string;
  templateName: string;
  reason: 'flash-timeout' | 'flash-error' | 'fetch-error' | 'dom-error';
  error?: string;
}
