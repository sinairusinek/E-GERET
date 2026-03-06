import type { ExtractionField } from '../types';

export interface StructuralUnit {
  index: number;
  fullText: string;       // all text content of this letter unit
  footnotes: string;      // correlated footnote text
  headingText: string;    // the heading/title of this unit (if heading-split)
}

export interface DomExtractionResult {
  results: Record<string, string>[];
  /** Fields that returned empty for ANY letter unit (excluding Footnotes) */
  incompleteFields: string[];
  /** True if all non-optional fields populated for all units */
  complete: boolean;
}

// Phase 3: Resolve footnote references in a container to their definitions in the full doc
function correlateFootnotes(container: Element, doc: Document): string {
  const refs = container.querySelectorAll('a[href^="#fn:"], a[href^="#fnref:"], a.footnote');
  const footnoteTexts: string[] = [];

  refs.forEach((ref) => {
    const href = ref.getAttribute('href');
    if (!href) return;
    const targetId = href.replace('#', '');
    const target = doc.getElementById(targetId);
    if (target) {
      const marker = ref.textContent?.trim() || '';
      const text = target.textContent?.trim() || '';
      if (text) {
        footnoteTexts.push(`[${marker}] ${text}`);
      }
    }
  });

  return footnoteTexts.join('\n');
}

// Build virtual container elements for heading-based splitting
function splitByHeadings(doc: Document, containerSelector: string): Element[] {
  const headings = Array.from(doc.querySelectorAll(containerSelector));
  if (headings.length === 0) return [doc.body];

  return headings.map((heading) => {
    const group = doc.createElement('div');
    group.appendChild(heading.cloneNode(true));
    let sibling = heading.nextElementSibling;
    while (sibling && !sibling.matches(containerSelector)) {
      group.appendChild(sibling.cloneNode(true));
      sibling = sibling.nextElementSibling;
    }
    return group;
  });
}

export function extractWithDOM(
  html: string,
  containerSelector: string,
  fields: ExtractionField[]
): DomExtractionResult {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // Determine containers
  let containers: Element[];
  const sel = (containerSelector || '').trim().toLowerCase();

  if (!sel || sel === 'body') {
    containers = [doc.body];
  } else if (/^h[1-6]$/.test(sel)) {
    // Phase 2: heading-based splitting
    containers = splitByHeadings(doc, containerSelector);
  } else {
    try {
      const matched = Array.from(doc.querySelectorAll(containerSelector));
      containers = matched.length > 0 ? matched : [doc.body];
    } catch {
      // Invalid containerSelector — fall back to body
      containers = [doc.body];
    }
  }

  const incompleteFieldsSet = new Set<string>();
  const results: Record<string, string>[] = [];

  for (const container of containers) {
    const record: Record<string, string> = {};

    for (const field of fields) {
      // Special handling for Footnotes (Phase 3)
      if (field.name === 'Footnotes') {
        record[field.name] = correlateFootnotes(container, doc);
        // Footnotes being empty is not a failure — many letters have none
        continue;
      }

      if (!field.selector) {
        record[field.name] = '';
        incompleteFieldsSet.add(field.name);
        continue;
      }

      // Phase 1 fix: head-element selectors (meta, title, link) must search the full doc
      try {
        const selectorTrimmed = field.selector.trim();
        const isHeadSelector = /^(meta|title|link)\b/.test(selectorTrimmed);
        const searchRoot = isHeadSelector ? doc : container;
        let text = '';
        if (selectorTrimmed.includes(',')) {
          const els = Array.from(searchRoot.querySelectorAll(selectorTrimmed));
          text = els.map(e => e.textContent?.trim()).filter(Boolean).join('\n');
        } else {
          const el = searchRoot.querySelector(selectorTrimmed);
          text = el?.textContent?.trim() || '';
        }
        record[field.name] = text;
        if (!text) incompleteFieldsSet.add(field.name);
      } catch {
        // Invalid CSS selector from old template — mark incomplete for Gemini fallback
        record[field.name] = '';
        incompleteFieldsSet.add(field.name);
      }
    }

    results.push(record);
  }

  const incompleteFields = Array.from(incompleteFieldsSet);

  return {
    results,
    incompleteFields,
    // complete = all fields populated for all units, and we got at least one unit
    complete: incompleteFields.length === 0 && results.length > 0,
  };
}

// Detect container + footnote selectors directly from DOM (no API call needed)
export function detectStructuralSelectors(html: string): { containerSelector: string; footnoteSelector: string } {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // Use the shallowest heading level present as the letter splitter
  let containerSelector = 'body';
  if (doc.querySelector('h2')) containerSelector = 'h2';
  else if (doc.querySelector('h3')) containerSelector = 'h3';
  else if (doc.querySelector('h4')) containerSelector = 'h4';

  // Try common footnote patterns in order of specificity
  let footnoteSelector = '';
  if (doc.querySelector('div.footnotes li')) footnoteSelector = 'div.footnotes li';
  else if (doc.querySelector('.footnotes li')) footnoteSelector = '.footnotes li';
  else if (doc.querySelector('li[id^="fn:"]')) footnoteSelector = 'li[id^="fn:"]';
  else if (doc.querySelector('ol.footnotes li')) footnoteSelector = 'ol.footnotes li';

  return { containerSelector, footnoteSelector };
}

// Phase 3: New structural extraction — DOM handles splitting + text, Flash handles semantics
export function extractStructural(
  html: string,
  containerSelector: string,
  footnoteSelector: string
): StructuralUnit[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // Same container resolution logic as extractWithDOM
  let containers: Element[];
  const sel = (containerSelector || '').trim().toLowerCase();

  if (!sel || sel === 'body') {
    containers = [doc.body];
  } else if (/^h[1-6]$/.test(sel)) {
    containers = splitByHeadings(doc, containerSelector);
  } else {
    try {
      const matched = Array.from(doc.querySelectorAll(containerSelector));
      containers = matched.length > 0 ? matched : [doc.body];
    } catch {
      containers = [doc.body];
    }
  }

  return containers.map((container, index) => {
    // First h1-h6 inside the container as heading text
    const headingEl = container.querySelector('h1, h2, h3, h4, h5, h6');
    const headingText = headingEl?.textContent?.trim() || '';

    const fullText = container.textContent?.trim() || '';

    // Try anchor-based footnote correlation first; fall back to footnoteSelector
    let footnotes = '';
    if (footnoteSelector) {
      footnotes = correlateFootnotes(container, doc);
      if (!footnotes) {
        try {
          const fnEls = Array.from(doc.querySelectorAll(footnoteSelector));
          footnotes = fnEls.map(el => el.textContent?.trim()).filter(Boolean).join('\n');
        } catch { /* invalid selector — skip */ }
      }
    }

    return { index, fullText, footnotes, headingText };
  });
}
