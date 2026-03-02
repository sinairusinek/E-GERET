
import { GoogleGenAI, Type } from "@google/genai";
import { ExtractionField, UploadedFile } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export interface SuggestionResponse {
  containerSelector: string;
  fields: ExtractionField[];
}

export const suggestTemplateFields = async (sampleHtml: string): Promise<SuggestionResponse> => {
  // Take a larger slice to ensure the footnotes section at the bottom is included
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
                selector: { type: Type.STRING, description: "Structural rule or CSS selector" }
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
    return JSON.parse(response.text || '{"containerSelector": "", "fields": []}');
  } catch (e) {
    console.error("Failed to parse suggestion", e);
    return { containerSelector: "", fields: [] };
  }
};

export const extractMetadata = async (
  file: UploadedFile, 
  containerSelector: string,
  fields: ExtractionField[]
): Promise<Record<string, string>[]> => {
  const fieldInstructions = fields.map(f => `- ${f.name}: ${f.description}. (Rule: ${f.selector})`).join('\n');

  // Footnotes are often at the bottom; we need a large chunk or the whole thing if possible.
  // For extremely large files, we focus on the letters and the footnote block specifically.
  const truncatedHtml = file.content.length > 60000 
    ? file.content.slice(0, 45000) + "\n... [truncated] ...\n" + file.content.slice(-15000)
    : file.content;

  const response = await ai.models.generateContent({
    model: 'gemini-3-pro-preview',
    contents: `EXTRACT DATA AND CORRELATE FOOTNOTES.
    
    INSTRUCTIONS:
    1. Identify individual units using selector: ${containerSelector}
    2. FOR EACH UNIT: Extract metadata and body text.
    3. FOOTNOTE CORRELATION (VERY IMPORTANT): 
       - If a letter contains pointers (e.g. <a href="#fn:1">), find the corresponding definition (e.g. <li id="fn:1">) in the document's footnote section.
       - Join the resolved footnote text into the 'Footnotes' field for that specific letter. 
       - Do not leave footnotes isolated at the bottom; attach them to the correct letter row.
    
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
          }, {} as Record<string, any>),
          required: fields.map(f => f.name)
        }
      }
    }
  });

  try {
    return JSON.parse(response.text || '[]');
  } catch (e) {
    console.error("Extraction failed", e);
    return [];
  }
};
