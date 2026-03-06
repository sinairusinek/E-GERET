<div align="center">

# E-GERET

**A Structured Dataset of 4,397 Historical Hebrew Letters**

Extracted from the [Ben Yehuda Project](https://benyehuda.org/) public domain literary corpus using AI-powered classification.

[Download JSON](output/e-geret-batch-export.json) &#8226; [Download TSV](output/e-geret-batch-export.tsv)

</div>

---

## The Dataset

E-GERET provides a structured, machine-readable dataset of **4,397 Hebrew letters** spanning the 18th--20th centuries, extracted from 430 HTML files in the [Ben Yehuda Project](https://benyehuda.org/) public domain literary archive. Each letter has been individually segmented from its source file and classified into structured fields using Google Gemini Flash.

The dataset is available in two formats in the [`output/`](output/) directory:

| File | Format | Size | Description |
|---|---|---|---|
| [`e-geret-batch-export.json`](output/e-geret-batch-export.json) | JSON | 20 MB | Full structured results with source metadata |
| [`e-geret-batch-export.tsv`](output/e-geret-batch-export.tsv) | TSV | 18 MB | Flat tabular export (UTF-8 BOM, 4,398 rows) |

### Fields Per Letter

| Field | Description | Coverage |
|---|---|---|
| **Content** | Full body text of the letter | 100% |
| **Recipient** | Who the letter is addressed to (from salutation/header) | 92% |
| **Date** | Date as written in the original text (any format/language) | 87% |
| **DateISO** | Normalized ISO 8601 date (YYYY-MM-DD, YYYY-MM, or YYYY) | 86% |
| **Location** | Where the letter was written from | 76% |
| **Sender** | Who wrote/signed the letter (from closing/signature) | 56% |
| **Signature** | Closing/valediction block | -- |
| **Footnotes** | Correlated footnote text from the source HTML | -- |

Each record also includes the original **CSV metadata** from the Ben Yehuda catalogue: title, author, period, publication date, original language, intellectual property status, and source URL.

### Coverage Notes

- **Sender at 56%** reflects the source material -- many historical Hebrew letters lack explicit signatures; authorship is often identifiable only from the surrounding collection title or the CSV author metadata (which is included in every record).
- **144 files** referenced in the Ben Yehuda metadata CSV were not found in the HTML corpus dump. These are listed in the JSON output under `missingFiles`.

### Sample Record (JSON)

```json
{
  "id": "40830-0",
  "letterIndex": 1,
  "sourceFile": "p819/m40830.html",
  "csvMetadata": {
    "title": "א. קובנר לר. בריינין",
    "authorString": "קובנר, אברהם אורי",
    "period": "haskalah",
    "origPublicationDate": "1904"
  },
  "extracted": {
    "Recipient": "ר. בריינין",
    "Sender": "א. א. קוונער",
    "Date": "דען 27 טען פעברואר, יאהר 1904",
    "DateISO": "1904-02-27",
    "Location": "לאמזשא",
    "Content": "אדון נכבד, זה כמעט ארבעים שנה ...",
    "Signature": "א. א. קוונער",
    "Footnotes": ""
  }
}
```

## How It Was Built

E-GERET (**E**xtractor for **GE**neral **RE**source **T**exts) uses a two-pass pipeline to extract structured letters from raw HTML:

1. **Pass 1 -- DOM structural analysis**: Each HTML file is parsed to detect heading-based letter boundaries (`<h2>`, `<h3>`, etc.), split into individual letter units, and stripped to plain text. Footnotes are correlated via anchor IDs.

2. **Pass 2 -- AI classification**: Each letter's plain text is sent to Google Gemini 2.5 Flash with a structured JSON schema. The model identifies recipient, sender, date, location, content, and signature fields. 10 letters are classified concurrently with exponential-backoff retry.

| Extraction Metric | Value |
|---|---|
| Total letters extracted | 4,397 |
| Source HTML files | 430 |
| Failed / deferred | 0 |
| Runtime | ~82 minutes |
| Model | Gemini 2.5 Flash |

### Reproducing the Extraction

Prerequisites: Node.js 18+, a [Gemini API key](https://aistudio.google.com/apikey), and the Ben Yehuda [public_domain_dump](https://github.com/projectbenyehuda/public_domain_dump) cloned as a sibling directory.

```bash
git clone https://github.com/sinairusinek/E-GERET.git
cd E-GERET
npm install
echo "VITE_GEMINI_API_KEY=your_key" > .env.local

# Run batch extraction
rm -f output/checkpoint.json
node scripts/batch-extract.mjs
```

The script resumes automatically from `output/checkpoint.json` if interrupted. A browser-based interactive UI is also available via `npm run dev`.

<details>
<summary><strong>Project structure</strong></summary>

```
E-GERET/
├── output/
│   ├── e-geret-batch-export.json   # ← The dataset (JSON)
│   └── e-geret-batch-export.tsv    # ← The dataset (TSV)
├── scripts/
│   └── batch-extract.mjs           # Standalone Node.js batch extractor
├── App.tsx                          # Browser UI (React + TypeScript)
├── components/                      # UI components
├── hooks/                           # React hooks (batch, extraction, upload)
├── services/
│   ├── geminiService.ts             # Gemini API integration
│   ├── domExtractionService.ts      # DOM structural analysis
│   ├── csvService.ts                # Ben Yehuda CSV parser
│   ├── dateService.ts               # Hebrew/Gregorian date parsing
│   ├── exportService.ts             # JSON, TSV, TEI-XML export
│   └── fingerprintService.ts        # DOM fingerprinting
└── types.ts                         # TypeScript type definitions
```

</details>

<details>
<summary><strong>Tech stack</strong></summary>

- **Frontend**: React 18, TypeScript, Vite, Tailwind CSS
- **AI**: Google Gemini 2.5 Flash (structured JSON output, thinking disabled for throughput)
- **Batch**: Node.js ESM, `@google/genai` SDK, 10x concurrent requests with exponential-backoff retry

</details>

## Acknowledgments

### Project Credit

This work was carried out by **Sinai Rusinek** as a **Pulmusim** (פולמוסים) pilot project, funded by the **[KKL Institute for the Study of Zionism and Settlement](https://www.kkl.org.il/research_institutes/zionism-settlement-institute/about/)** (מכון קק"ל לחקר הציונות וההתיישבות).

### Data Source

The source texts are from **[Project Ben-Yehuda](https://benyehuda.org/)** (פרויקט בן-יהודה), a digital repository of over 61,000 Hebrew literary works maintained by the Association for Computerization of Hebrew Literature (העמותה למחשוב ספרות עברית).

All texts in the corpus are in the **public domain** (נחלת הכלל). Per the project's guidelines:

> *All these works are in the public domain, so you are free to make any use of them.*

Credit: **[Project Ben-Yehuda volunteers](https://benyehuda.org/)** for digitizing and curating this invaluable collection of Hebrew literary heritage.

The HTML files and metadata CSV are sourced from the [public_domain_dump](https://github.com/projectbenyehuda/public_domain_dump) repository on GitHub.

## License

The extracted correspondence data inherits the **public domain** status of the source texts from Project Ben-Yehuda.

The E-GERET application code is available under the [MIT License](LICENSE).
