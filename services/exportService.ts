import type { BatchExtractedData, FileManifestEntry, DeferredFile } from '../types';

async function saveFile(content: string, filename: string): Promise<void> {
  try {
    const res = await fetch('/api/save-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, content }),
    });
    const json = await res.json() as { ok: boolean; path?: string; error?: string };
    if (json.ok) {
      console.log(`Saved: ${json.path}`);
    } else {
      console.error(`Save failed for ${filename}:`, json.error);
    }
  } catch (err) {
    console.error(`Save request failed for ${filename}:`, err);
  }
}

// --- JSON Export ---

export async function exportJSON(
  results: BatchExtractedData[],
  missingFiles: FileManifestEntry[]
): Promise<void> {
  const output = {
    results: results.map((r) => ({
      id: r.id,
      letterIndex: r.letterIndex,
      sourceFile: r.sourceFile,
      templateUsed: r.templateName,
      csvMetadata: r.csv,
      extracted: r.data,
    })),
    summary: {
      totalLettersExtracted: results.length,
      totalFiles: new Set(results.map((r) => r.sourceFile)).size,
      missingFiles: missingFiles.length,
      templatesUsed: new Set(results.map((r) => r.templateName)).size,
    },
    missingFiles: missingFiles.map((m) => ({
      id: m.csv.id,
      title: m.csv.title,
      authorString: m.csv.authorString,
      htmlPath: m.htmlPath.replace('/corpus/', ''),
      intellectualProperty: m.csv.intellectualProperty,
    })),
  };
  await saveFile(JSON.stringify(output, null, 2), 'e-geret-batch-export.json');
}

// --- TSV Export ---

function escapeForTSV(value: string): string {
  return (value || '').replace(/\t/g, ' ').replace(/\n/g, ' ').replace(/\r/g, '');
}

export async function exportTSV(results: BatchExtractedData[]): Promise<void> {
  if (results.length === 0) return;

  const extractedFieldNames = new Set<string>();
  results.forEach((r) => {
    Object.keys(r.data).forEach((k) => extractedFieldNames.add(k));
  });
  const fieldNames = Array.from(extractedFieldNames);

  const csvCols = [
    'id', 'title', 'authorString', 'period',
    'origPublicationDate', 'origLang', 'intellectualProperty', 'url',
  ];

  const headers = [
    ...csvCols,
    'sourceFile', 'letterIndex', 'templateUsed',
    ...fieldNames,
  ];

  const rows = results.map((r) => {
    const csvValues = csvCols.map((col) => {
      const val = r.csv[col as keyof typeof r.csv];
      return escapeForTSV(Array.isArray(val) ? val.join(', ') : String(val ?? ''));
    });
    const metaValues = [
      escapeForTSV(r.sourceFile),
      String(r.letterIndex),
      escapeForTSV(r.templateName),
    ];
    const extractedValues = fieldNames.map((name) =>
      escapeForTSV(r.data[name] || '')
    );
    return [...csvValues, ...metaValues, ...extractedValues].join('\t');
  });

  const tsv = '\uFEFF' + [headers.join('\t'), ...rows].join('\n');
  await saveFile(tsv, 'e-geret-batch-export.tsv');
}

// --- TEI-XML Export ---

function escapeXml(str: string): string {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function exportTEI(results: BatchExtractedData[]): Promise<void> {
  if (results.length === 0) return;

  const correspDescs = results.map((r) => {
    const xmlId = `letter-${r.csv.id}-${r.letterIndex}`;
    const ref = r.csv.url ? ` ref="${escapeXml(r.csv.url)}"` : '';
    const senderName = r.data['Sender'] || r.csv.authorString || '';
    const recipientName = r.data['Recipient'] || '';
    const dateDisplay = r.data['Date'] || '';
    const dateISO = r.data['DateISO'] || '';
    const location = r.data['Location'] || '';

    let sentAction = '        <correspAction type="sent">\n';
    if (senderName) sentAction += `          <persName>${escapeXml(senderName)}</persName>\n`;
    if (location) sentAction += `          <placeName>${escapeXml(location)}</placeName>\n`;
    if (dateDisplay || dateISO) {
      const whenAttr = dateISO ? ` when="${escapeXml(dateISO)}"` : '';
      sentAction += `          <date${whenAttr}>${escapeXml(dateDisplay)}</date>\n`;
    }
    sentAction += '        </correspAction>';

    let receivedAction = '';
    if (recipientName) {
      receivedAction = `\n        <correspAction type="received">\n          <persName>${escapeXml(recipientName)}</persName>\n        </correspAction>`;
    }
    return `      <correspDesc xml:id="${escapeXml(xmlId)}"${ref}>\n${sentAction}${receivedAction}\n      </correspDesc>`;
  });

  const bodyDivs = results.map((r) => {
    const xmlId = `letter-${r.csv.id}-${r.letterIndex}`;
    const content = r.data['Content'] || '';
    const footnotes = r.data['Footnotes'] || '';

    let divContent = '';
    if (content) {
      const paragraphs = content.split(/\n+/).filter((p) => p.trim());
      divContent = paragraphs
        .map((p) => `        <p>${escapeXml(p.trim())}</p>`)
        .join('\n');
    }
    if (footnotes) {
      divContent += `\n        <note type="footnotes">${escapeXml(footnotes)}</note>`;
    }
    return `      <div type="letter" decls="#${escapeXml(xmlId)}">\n${divContent || '        <p/>'}\n      </div>`;
  });

  const tei = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>E-GERET Correspondence Export</title>
      </titleStmt>
      <publicationStmt>
        <p>Extracted by E-GERET from the Ben Yehuda Project corpus</p>
      </publicationStmt>
      <sourceDesc>
        <p>Ben Yehuda Project (benyehuda.org)</p>
      </sourceDesc>
    </fileDesc>
    <profileDesc>
${correspDescs.join('\n')}
    </profileDesc>
  </teiHeader>
  <text>
    <body>
${bodyDivs.join('\n')}
    </body>
  </text>
</TEI>`;

  await saveFile(tei, 'e-geret-batch-export.xml');
}

// --- Missing Files Export ---

export async function exportMissingFiles(missingFiles: FileManifestEntry[]): Promise<void> {
  const output = missingFiles.map((m) => ({
    id: m.csv.id,
    title: m.csv.title,
    authorString: m.csv.authorString,
    htmlPath: m.htmlPath.replace('/corpus/', ''),
    intellectualProperty: m.csv.intellectualProperty,
    url: m.csv.url,
  }));
  await saveFile(JSON.stringify(output, null, 2), 'e-geret-missing-files.json');
}

// --- Deferred Files Manifest Export ---

export async function exportDeferred(deferred: DeferredFile[]): Promise<void> {
  const output = deferred.map(d => ({
    fileId: d.entry.csv.id,
    title: d.entry.csv.title,
    htmlPath: d.entry.htmlPath,
    cluster: d.clusterId,
    template: d.templateName,
    reason: d.reason,
    error: d.error,
  }));
  await saveFile(JSON.stringify(output, null, 2), 'e-geret-deferred-files.json');
}
