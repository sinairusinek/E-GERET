import type { CsvMetadata, FileManifestEntry } from '../types';

function parseCSVRow(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseAuthorIds(raw: string): number[] {
  const matches = raw.match(/\d+/g);
  return matches ? matches.map(Number) : [];
}

export async function loadManifest(): Promise<{
  entries: FileManifestEntry[];
  total: number;
  lettersCount: number;
}> {
  const res = await fetch('/benyehuda-full-metadata.csv');
  const text = await res.text();
  const lines = text.split('\n').filter((l) => l.trim());

  if (lines.length < 2) {
    return { entries: [], total: 0, lettersCount: 0 };
  }

  const headers = parseCSVRow(lines[0]);
  const colIndex: Record<string, number> = {};
  headers.forEach((h, i) => {
    colIndex[h] = i;
  });

  const entries: FileManifestEntry[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVRow(lines[i]);
    const genre = cols[colIndex['genre']] || '';
    if (genre !== 'letters') continue;

    const id = parseInt(cols[colIndex['id']], 10);
    const authorIdsRaw = cols[colIndex['author_ids']] || '[]';
    const authorIds = parseAuthorIds(authorIdsRaw);
    const firstAuthorId = authorIds[0];

    if (!firstAuthorId || isNaN(id)) continue;

    const csv: CsvMetadata = {
      id,
      title: cols[colIndex['title']] || '',
      authorString: cols[colIndex['author_string']] || '',
      authorIds,
      origLang: cols[colIndex['orig_lang']] || '',
      origPublicationDate: cols[colIndex['orig_publication_date']] || '',
      period: cols[colIndex['period']] || '',
      intellectualProperty: cols[colIndex['intellectual_property']] || '',
      url: cols[colIndex['url']] || '',
    };

    entries.push({
      csv,
      htmlPath: `/corpus/p${firstAuthorId}/m${id}.html`,
      status: 'pending',
    });
  }

  return { entries, total: lines.length - 1, lettersCount: entries.length };
}

export async function checkFileExists(path: string): Promise<boolean> {
  try {
    const res = await fetch(path, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}
