/**
 * Hebrew/Gregorian date normalization utility.
 *
 * Returns:
 *   - ISO string (YYYY-MM-DD, YYYY-MM, or YYYY) if parseable
 *   - '' (empty string) if the input is empty / no date
 *   - null if the date can't be parsed locally (signal Gemini fallback needed)
 */

const HEBREW_GREGORIAN_MONTHS: Record<string, number> = {
  'ינואר': 1,
  'פברואר': 2,
  'מרץ': 3,
  'מרס': 3,
  'אפריל': 4,
  'מאי': 5,
  'יוני': 6,
  'יולי': 7,
  'אוגוסט': 8,
  'ספטמבר': 9,
  'אוקטובר': 10,
  'נובמבר': 11,
  'דצמבר': 12,
};

// Hebrew calendar month names — signals we need Gemini to convert
const HEBREW_CALENDAR_MONTHS = [
  'ניסן', 'נסן', 'אייר', 'סיון', 'תמוז', 'אב', 'אלול',
  'תשרי', 'חשון', 'מרחשון', 'כסלו', 'טבת', 'שבט', 'אדר',
];

const ENGLISH_MONTHS: Record<string, number> = {
  'january': 1, 'february': 2, 'march': 3, 'april': 4,
  'may': 5, 'june': 6, 'july': 7, 'august': 8,
  'september': 9, 'october': 10, 'november': 11, 'december': 12,
  'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4,
  'jun': 6, 'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12,
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function normalizeDateToISO(dateStr: string): string | null {
  if (!dateStr?.trim()) return ''; // No date — return empty, no Gemini needed

  const s = dateStr.trim();

  // Already ISO: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // Already ISO partial: YYYY-MM or YYYY
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  if (/^\d{4}$/.test(s)) return s;

  // Slash-separated: DD/MM/YYYY or MM/DD/YYYY (assume DD/MM for Hebrew context)
  const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, d, m, y] = slashMatch;
    return `${y}-${pad2(Number(m))}-${pad2(Number(d))}`;
  }

  // Dot-separated: DD.MM.YYYY
  const dotMatch = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (dotMatch) {
    const [, d, m, y] = dotMatch;
    return `${y}-${pad2(Number(m))}-${pad2(Number(d))}`;
  }

  // Hebrew calendar months — return null (needs Gemini)
  for (const hebrewMonth of HEBREW_CALENDAR_MONTHS) {
    if (s.includes(hebrewMonth)) return null;
  }

  // Hebrew Gregorian: "5 בינואר 1920" or "ה' בינואר 1920" or "ה׳ ינואר 1920"
  for (const [hebrewMonth, monthNum] of Object.entries(HEBREW_GREGORIAN_MONTHS)) {
    // With day: "5 בינואר 1920" or "ה' בינואר 1920"
    const dayPattern = new RegExp(
      `([\\d]+|[א-ת][׳']?)\\s+ב?${hebrewMonth}\\s+(\\d{4})`
    );
    const dayMatch = s.match(dayPattern);
    if (dayMatch) {
      const dayStr = dayMatch[1];
      const year = dayMatch[2];
      const day = parseInt(dayStr, 10);
      if (!isNaN(day) && day >= 1 && day <= 31) {
        return `${year}-${pad2(monthNum)}-${pad2(day)}`;
      }
      // Day is Hebrew numeral — return year-month only
      return `${year}-${pad2(monthNum)}`;
    }

    // Without day: "ינואר 1920" or "בינואר 1920"
    const monthOnlyPattern = new RegExp(`ב?${hebrewMonth}\\s+(\\d{4})`);
    const monthOnlyMatch = s.match(monthOnlyPattern);
    if (monthOnlyMatch) {
      return `${monthOnlyMatch[1]}-${pad2(monthNum)}`;
    }
  }

  // English: "January 5, 1920" or "5 January 1920" or "Jan 1920"
  // "Month Day, Year"
  const engMDY = s.match(/^(\w+)\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (engMDY) {
    const month = ENGLISH_MONTHS[engMDY[1].toLowerCase()];
    if (month) {
      return `${engMDY[3]}-${pad2(month)}-${pad2(Number(engMDY[2]))}`;
    }
  }

  // "Day Month Year"
  const engDMY = s.match(/^(\d{1,2})\s+(\w+)\s+(\d{4})$/i);
  if (engDMY) {
    const month = ENGLISH_MONTHS[engDMY[2].toLowerCase()];
    if (month) {
      return `${engDMY[3]}-${pad2(month)}-${pad2(Number(engDMY[1]))}`;
    }
  }

  // "Month Year" (no day)
  const engMY = s.match(/^(\w+)\s+(\d{4})$/i);
  if (engMY) {
    const month = ENGLISH_MONTHS[engMY[1].toLowerCase()];
    if (month) {
      return `${engMY[2]}-${pad2(month)}`;
    }
  }

  // Standalone 4-digit year (possibly with surrounding text)
  const yearMatch = s.match(/\b(\d{4})\b/);
  if (yearMatch && /^[\d\s\-\/\.,']+$/.test(s)) {
    return yearMatch[1];
  }

  // Can't parse — signal Gemini fallback
  return null;
}
