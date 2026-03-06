import type { SavedTemplate } from '../types';

export interface StructuralFingerprint {
  h2Count: 'none' | 'few' | 'many';
  hasFootnoteAnchors: boolean;
  hasFootnoteDefs: boolean;
  hasLtrSections: boolean;
  hasFigures: boolean;
  strongCount: 'none' | 'few' | 'many';
  blockquoteSeparators: 'none' | 'few' | 'many';
  key: string;
}

function bucket(count: number, fewThreshold = 3, manyThreshold = 10): 'none' | 'few' | 'many' {
  if (count === 0) return 'none';
  if (count <= fewThreshold) return 'few';
  return 'many';
}

export function computeFingerprint(html: string): StructuralFingerprint {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Look within the main RTL content div, falling back to body
  const root = doc.querySelector('div[dir="rtl"]') || doc.body;

  const h2s = root.querySelectorAll('h2');
  const fnAnchors = root.querySelectorAll('a[href^="#fn:"], a.footnote');
  const fnDefs = root.querySelectorAll('li[id^="fn:"], ol.footnotes li');
  const ltrDivs = root.querySelectorAll('div[dir="ltr"]');
  const figures = root.querySelectorAll('figure');
  const strongs = root.querySelectorAll('strong');

  // Count blockquote separators: <blockquote> that contain only whitespace or <br>
  let bqSeparatorCount = 0;
  const blockquotes = root.querySelectorAll('blockquote');
  blockquotes.forEach((bq) => {
    const text = bq.textContent?.trim() || '';
    const childElements = bq.querySelectorAll('*:not(br)');
    if (text === '' && childElements.length === 0) {
      bqSeparatorCount++;
    }
  });

  const fp: Omit<StructuralFingerprint, 'key'> = {
    h2Count: bucket(h2s.length),
    hasFootnoteAnchors: fnAnchors.length > 0,
    hasFootnoteDefs: fnDefs.length > 0,
    hasLtrSections: ltrDivs.length > 0,
    hasFigures: figures.length > 0,
    strongCount: bucket(strongs.length, 5, 20),
    blockquoteSeparators: bucket(bqSeparatorCount),
  };

  const key = [
    `h2:${fp.h2Count}`,
    `fnA:${fp.hasFootnoteAnchors}`,
    `fnD:${fp.hasFootnoteDefs}`,
    `ltr:${fp.hasLtrSections}`,
    `fig:${fp.hasFigures}`,
    `strong:${fp.strongCount}`,
    `bqSep:${fp.blockquoteSeparators}`,
  ].join('|');

  return { ...fp, key };
}

export function describeFingerprint(fp: StructuralFingerprint): string {
  const parts: string[] = [];

  if (fp.h2Count !== 'none') {
    parts.push(fp.h2Count === 'many' ? 'Multi-section with headers' : 'Few section headers');
  } else {
    parts.push('No section headers');
  }

  if (fp.hasFootnoteAnchors || fp.hasFootnoteDefs) {
    parts.push('footnotes');
  }

  if (fp.hasLtrSections) {
    parts.push('LTR/bilingual sections');
  }

  if (fp.hasFigures) {
    parts.push('images/figures');
  }

  if (fp.strongCount === 'many') {
    parts.push('heavy emphasis/labels');
  }

  if (fp.blockquoteSeparators !== 'none') {
    parts.push(fp.blockquoteSeparators === 'many' ? 'many separators' : 'few separators');
  }

  return parts.join(', ');
}

export function matchFingerprint(
  fingerprintKey: string,
  templates: SavedTemplate[]
): SavedTemplate | null {
  return templates.find((t) => t.fingerprint === fingerprintKey) || null;
}
