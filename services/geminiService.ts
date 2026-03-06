
import { GoogleGenAI, Type } from "@google/genai";
import { ExtractionField, UploadedFile } from "../types";

export interface StructuralSuggestion {
  containerSelector: string;
  footnoteSelector: string;
}

const ai = new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY });

export interface SuggestionResponse {
  containerSelector: string;
  fields: ExtractionField[];
}

async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  retries = 2,
  delayMs = 1000
): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    signal.throwIfAborted();
    try {
      return await fn(signal);
    } catch (err) {
      if (signal.aborted) throw err;
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
  throw new Error('Unreachable');
}

export const suggestTemplateFields = async (
  sampleHtml: string,
  signal: AbortSignal = new AbortController().signal
): Promise<SuggestionResponse> => {
  return withRetry(async () => {
    const truncatedHtml = sampleHtml.slice(0, 35000);

    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Analyze this HTML correspondence document to identify its structural units and metadata.

      CRITICAL STRUCTURAL ANALYSIS:
      1. Identify the 'containerSelector': The HTML element wrapping each individual letter (the repeating unit).
      2. FOOTNOTES: Check for a footnote system. Common pattern:
         - Pointers in body: <a href="#fn:1"> or similar.
         - Footnote list: <div class="footnotes"> containing <li id="fn:1">.
      3. FIELD MAPPING:
         - Suggest fields for metadata (Sender, Date, Ref).
         - ALWAYS include 'Content' (the body text of the letter).
         - ALWAYS include 'Footnotes' if pointers/definitions are detected.
      4. SELECTOR FORMAT: All field selectors MUST be valid CSS selectors usable with
         document.querySelector(). Use standard CSS syntax (e.g., "h2", "p:first-of-type",
         "strong", ".footnotes li"). Do NOT use natural language descriptions.

      HTML Snippet:
      ${truncatedHtml}`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            containerSelector: { type: Type.STRING, description: "CSS selector for the letter wrapper" },
            fields: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  name: { type: Type.STRING },
                  description: { type: Type.STRING, description: "What to extract and how to handle footnotes for this field" },
                  selector: { type: Type.STRING, description: "Valid CSS selector usable with document.querySelector()" }
                },
                required: ["id", "name", "description", "selector"]
              }
            }
          },
          required: ["containerSelector", "fields"]
        }
      }
    });

    try {
      const parsed = JSON.parse(response.text || '{}');
      if (!parsed.containerSelector || !Array.isArray(parsed.fields)) {
        console.warn('Unexpected suggestion shape:', parsed);
        return { containerSelector: '', fields: [] };
      }
      return parsed as SuggestionResponse;
    } catch (e) {
      console.error("Failed to parse suggestion", e);
      return { containerSelector: "", fields: [] };
    }
  }, signal);
};

export const extractMetadata = async (
  file: UploadedFile,
  containerSelector: string,
  fields: ExtractionField[],
  signal: AbortSignal = new AbortController().signal
): Promise<Record<string, string>[]> => {
  return withRetry(async () => {
    const fieldInstructions = fields.map(f => `- ${f.name}: ${f.description}. (Rule: ${f.selector})`).join('\n');

    const truncatedHtml = file.content.length > 60000
      ? file.content.slice(0, 45000) + "\n... [truncated] ...\n" + file.content.slice(-15000)
      : file.content;

    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `EXTRACT DATA AND CORRELATE FOOTNOTES.

      INSTRUCTIONS:
      1. Identify individual units using selector: ${containerSelector}
      2. FOR EACH UNIT: Extract metadata and body text.
      3. FOOTNOTE CORRELATION (VERY IMPORTANT):
         - If a letter contains pointers (e.g. <a href="#fn:1">), find the corresponding definition (e.g. <li id="fn:1">) in the document's footnote section.
         - Join the resolved footnote text into the 'Footnotes' field for that specific letter.
         - Do not leave footnotes isolated at the bottom; attach them to the correct letter row.
      4. DATE NORMALIZATION: If a Date field is present, ALSO provide a 'DateISO' field with
         the date in ISO 8601 format (YYYY-MM-DD). Normalize from any calendar/language.
         If the exact day is unknown, use YYYY-MM or YYYY. If no date is found, use "".

      FIELDS:
      ${fieldInstructions}

      HTML CONTENT:
      ${truncatedHtml}`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: fields.reduce((acc, field) => {
              acc[field.name] = { type: Type.STRING };
              return acc;
            }, { DateISO: { type: Type.STRING, description: "Date in ISO 8601 format (YYYY-MM-DD)" } } as Record<string, any>),
            required: [...fields.map(f => f.name), 'DateISO']
          }
        }
      }
    });

    try {
      const parsed = JSON.parse(response.text || '[]');
      if (!Array.isArray(parsed)) {
        console.warn('Expected array from extraction, got:', typeof parsed);
        return [];
      }
      return parsed;
    } catch (e) {
      console.error("Extraction failed", e);
      return [];
    }
  }, signal);
};

// Phase 4a: Structural-only template detection (containerSelector + footnoteSelector only)
export const suggestStructuralTemplate = async (
  sampleHtml: string,
  signal: AbortSignal = new AbortController().signal
): Promise<StructuralSuggestion> => {
  return withRetry(async () => {
    const truncatedHtml = sampleHtml.slice(0, 35000);

    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Analyze this HTML correspondence document to identify its structure.

      TASK: Identify TWO things only:
      1. containerSelector: The CSS selector for the repeating letter unit.
         - If letters are separated by headings (h2, h3), return that heading tag (e.g. "h2").
         - If the document is a single letter, return "body".
         - If letters are in specific wrapper divs, return that selector (e.g. "div.letter").
      2. footnoteSelector: CSS selector for footnote definitions, or "" if none.
         - Look for: .footnotes li, li[id^="fn:"], ol.footnotes li, etc.
         - Return "" if no footnote system is detected.

      HTML Snippet:
      ${truncatedHtml}`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            containerSelector: {
              type: Type.STRING,
              description: "CSS selector for letter unit wrapper, or heading tag for splitting"
            },
            footnoteSelector: {
              type: Type.STRING,
              description: "CSS selector for footnote definitions, or empty string"
            }
          },
          required: ["containerSelector", "footnoteSelector"]
        }
      }
    });

    const parsed = JSON.parse(response.text || '{}');
    return {
      containerSelector: parsed.containerSelector || 'body',
      footnoteSelector: parsed.footnoteSelector || '',
    };
  }, signal);
};

// Phase 4b: Flash classification of a single letter unit's plain text → semantic fields
export const classifyLetterText = async (
  letterText: string,
  footnotes: string,
  signal: AbortSignal = new AbortController().signal
): Promise<Record<string, string>> => {
  return withRetry(async () => {
    const text = letterText.slice(0, 8000);

    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Given this Hebrew/multilingual letter text, identify and extract the following fields.
      Return each field's value as extracted from the text. If a field is not present, return "".

      FIELDS TO EXTRACT:
      - Recipient: Who the letter is addressed to (name/title from salutation or header)
      - Sender: Who wrote/signed the letter (name from closing/signature)
      - Date: The date as written in the original text (any format/language)
      - DateISO: The date normalized to ISO 8601 (YYYY-MM-DD, YYYY-MM, or YYYY). Convert from any calendar.
      - Location: Where the letter was written from (city/place name)
      - Content: The main body text of the letter (FULL text, not a summary)
      - Signature: The closing/signature block (valediction + name)

      IMPORTANT:
      - Recipient is who RECEIVES the letter, Sender is who WRITES it. Do not confuse them.
      - For Content, include the FULL body text, not a summary or excerpt.
      - For DateISO, convert Hebrew calendar dates to Gregorian if possible.
      - All fields should contain the original text as-is (Hebrew, English, etc.)

      LETTER TEXT:
      ${text}`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            Recipient: { type: Type.STRING },
            Sender: { type: Type.STRING },
            Date: { type: Type.STRING },
            DateISO: { type: Type.STRING },
            Location: { type: Type.STRING },
            Content: { type: Type.STRING },
            Signature: { type: Type.STRING },
          },
          required: ["Recipient", "Sender", "Date", "DateISO", "Location", "Content", "Signature"]
        }
      }
    });

    const parsed = JSON.parse(response.text || '{}');
    // Attach footnotes from DOM correlation (not Flash)
    parsed.Footnotes = footnotes || '';
    return parsed;
  }, signal);
};
