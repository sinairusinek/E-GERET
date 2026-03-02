
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
  fields: ExtractionField[];
  createdAt: number;
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
  VIEWING_RESULTS = 'VIEWING_RESULTS'
}
