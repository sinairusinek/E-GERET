<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />

# E-GERET

**AI-Powered Correspondence Extractor for Hebrew Literary Archives**

Extract, classify, and structure historical Hebrew letters from the [Ben Yehuda Project](https://benyehuda.org/) corpus using Google Gemini.

</div>

---

## Overview

E-GERET (**E**xtractor for **GE**neral **RE**source **T**exts) is a React + TypeScript application that analyzes Hebrew HTML correspondence files from the Ben Yehuda Project's public domain literary archive. It uses a two-pass pipeline combining DOM structural analysis with Google Gemini Flash classification to extract structured metadata from thousands of historical letters spanning the 18th-20th centuries.

### What It Does

Given a corpus of HTML files containing Hebrew letters, E-GERET:

1. **Detects document structure** -- identifies heading-based letter boundaries, footnote patterns, and container elements using pure DOM analysis
2. **Splits multi-letter files** -- many HTML files contain collections of 5-50+ letters under heading tags (`<h2>`, `<h3>`, etc.)
3. **Extracts metadata via AI** -- sends each letter's plain text to Gemini Flash for structured classification
4. **Exports structured data** -- produces JSON and TSV files with per-letter fields:

| Field | Description |
|---|---|
| Recipient | Who the letter is addressed to |
| Sender | Who wrote/signed the letter |
| Date | Original date as written (Hebrew, European, etc.) |
| DateISO | Normalized ISO 8601 date |
| Location | Where the letter was sent from |
| Content | Full body text |
| Signature | Closing/valediction block |
| Footnotes | Correlated footnote text |

## Batch Extraction Results

The standalone batch extractor (`scripts/batch-extract.mjs`) processed the full Ben Yehuda letters corpus:

| Metric | Value |
|---|---|
| Letters extracted | **4,397** |
| Source files processed | **430** |
| Files not on disk | 144 |
| Deferred/failed | **0** |
| Runtime | ~82 minutes |

### Field Coverage

| Field | Populated | Coverage |
|---|---|---|
| Content | 4,384 | 100% |
| Recipient | 4,028 | 92% |
| Date | 3,814 | 87% |
| DateISO | 3,768 | 86% |
| Location | 3,326 | 76% |
| Sender | 2,475 | 56% |

The lower Sender coverage (56%) reflects the nature of the source material -- many historical Hebrew letters lack explicit signatures, with authorship identifiable only from the surrounding collection context or CSV metadata.

## Architecture

```
E-GERET/
├── App.tsx                  # Main UI component (manual + batch modes)
├── components/
│   ├── BatchPanel.tsx       # Batch processing UI
│   ├── ClusterCard.tsx      # File cluster visualization
│   ├── HtmlPreview.tsx      # HTML source preview
│   ├── Dialog.tsx           # Accessible modal dialogs
│   └── ErrorBoundary.tsx    # React error boundary
├── hooks/
│   ├── useBatchProcess.ts   # Two-pass batch pipeline
│   ├── useExtraction.ts     # Per-file Gemini extraction
│   ├── useFileUpload.ts     # File upload handling
│   └── useTemplates.ts      # Template CRUD (localStorage)
├── services/
│   ├── geminiService.ts     # Gemini API (structural + classification)
│   ├── domExtractionService.ts  # DOM-based structural extraction
│   ├── csvService.ts        # Ben Yehuda CSV manifest parser
│   ├── dateService.ts       # Hebrew/Gregorian date parsing
│   ├── fingerprintService.ts    # DOM structural fingerprinting
│   └── exportService.ts     # JSON, TSV, TEI-XML export
├── scripts/
│   └── batch-extract.mjs    # Standalone Node.js batch extractor
├── output/                  # Batch extraction results (gitignored)
└── types.ts                 # TypeScript type definitions
```

### Pipeline

**Browser mode** -- upload individual HTML files, detect structure, extract with Gemini interactively.

**Batch mode** (`scripts/batch-extract.mjs`) -- standalone Node.js script for processing the full corpus:

1. **Pass 1 (DOM)**: Read all HTML files, detect heading structure, split into letter units, strip HTML to plain text
2. **Pass 2 (Gemini Flash)**: Classify each unit concurrently (10 parallel requests) with structured JSON schema output
3. **Export**: Save JSON + TSV to `output/`, with incremental checkpoints every 50 units

The batch script includes exponential-backoff retry (3 attempts), quota-aware pausing, and automatic checkpoint resume.

## Setup

### Prerequisites

- Node.js 18+
- A [Google Gemini API key](https://aistudio.google.com/apikey)
- The Ben Yehuda [public domain dump](https://github.com/projectbenyehuda/public_domain_dump) cloned as a sibling directory

### Installation

```bash
git clone https://github.com/YOUR_USERNAME/E-GERET.git
cd E-GERET
npm install
```

Create `.env.local` with your Gemini API key:

```
VITE_GEMINI_API_KEY=your_api_key_here
```

### Running the Browser UI

```bash
npm run dev
```

Opens at `http://localhost:3000`. Upload HTML files or use batch mode to process files via the CSV manifest.

### Running the Batch Extractor

Ensure the Ben Yehuda HTML corpus is at `../public_domain_dump/html/` relative to the project root.

```bash
# Fresh run
rm -f output/checkpoint.json
node scripts/batch-extract.mjs

# Background run with logging
nohup node scripts/batch-extract.mjs > output/batch-run.log 2>&1 &
tail -f output/batch-run.log
```

The script resumes automatically from `output/checkpoint.json` if interrupted.

## Output Files

| File | Description |
|---|---|
| `output/e-geret-batch-export.json` | Full structured results with CSV metadata |
| `output/e-geret-batch-export.tsv` | Tab-separated flat export (UTF-8 BOM) |
| `output/checkpoint.json` | Resume checkpoint (intermediate state) |

## Tech Stack

- **Frontend**: React 18, TypeScript, Vite, Tailwind CSS
- **AI**: Google Gemini 2.5 Flash (structured JSON output, thinking disabled for throughput)
- **Batch**: Node.js ESM, `@google/genai` SDK

## Data Source & Acknowledgments

The source texts are from **[Project Ben-Yehuda](https://benyehuda.org/)** (פרויקט בן-יהודה), a digital repository of over 61,000 Hebrew literary works maintained by the Association for Computerization of Hebrew Literature (העמותה למחשוב ספרות עברית).

All texts in the corpus are in the **public domain** (נחלת הכלל). Per the project's guidelines:

> *All these works are in the public domain, so you are free to make any use of them.*

Credit: **[Project Ben-Yehuda volunteers](https://benyehuda.org/)** for digitizing and curating this invaluable collection of Hebrew literary heritage.

The HTML files and metadata CSV are sourced from the [public_domain_dump](https://github.com/projectbenyehuda/public_domain_dump) repository on GitHub.

## License

The extracted correspondence data inherits the **public domain** status of the source texts from Project Ben-Yehuda.

The E-GERET application code is available under the [MIT License](LICENSE).
