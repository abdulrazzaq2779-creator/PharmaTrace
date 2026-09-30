/**
 * Ground extracted values in OCR/vision raw text so invented strings never
 * reach the UI. Shared by the client pipeline and the /api/scan server.
 */

export function collapseSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Uppercase + collapse spaces. */
export function normalizePackText(text: string): string {
  return collapseSpaces(text.toUpperCase());
}

/**
 * Label-word OCR repairs: `( [ { ! |` → E when a label is expected;
 * 0→O and 1→I inside short alphabetic tokens.
 */
export function repairLabelConfusions(text: string): string {
  let out = normalizePackText(text);
  // Opening punctuation often eaten as the leading E of EXP / EXPIRY.
  out = out.replace(/[(\[{!|](?=X?P)/g, 'E');
  out = out.replace(/\b([A-Z01]{2,12})\b/g, token => {
    if (/\d{2,}/.test(token) && /[A-Z]/.test(token) === false) return token;
    const letters = token.replace(/[01]/g, ch => (ch === '0' ? 'O' : 'I'));
    if (/^[A-Z]+$/.test(letters) && letters.length <= 12) return letters;
    return token;
  });
  return collapseSpaces(out);
}

export function alnumKey(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return 99;
  const row = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) row[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const cur = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = cur;
    }
  }
  return row[n];
}

/** True if needle appears in haystack allowing 1-char edits on short tokens. */
export function fuzzyContains(haystack: string, needle: string): boolean {
  if (!needle.trim()) return false;
  const hay = normalizePackText(haystack);
  const ned = normalizePackText(needle);
  if (hay.includes(ned)) return true;

  const hayKey = alnumKey(hay);
  const nedKey = alnumKey(ned);
  if (nedKey.length >= 3 && hayKey.includes(nedKey)) return true;

  // Dates: 03/2026 vs 03-2026 vs 032026
  const date = ned.match(/^(\d{2})[/\-]?(\d{4})$/);
  if (date && hayKey.includes(`${date[1]}${date[2]}`)) return true;

  // Money: ₹54.00 / 54.00 / RS 54.00
  const money = ned.replace(/[₹$,]/g, '').match(/(\d+\.\d{1,2})/);
  if (money && hay.replace(/,/g, '').includes(money[1])) return true;

  if (nedKey.length >= 5 && nedKey.length <= 24) {
    for (let i = 0; i <= hayKey.length - nedKey.length; i++) {
      if (editDistance(hayKey.slice(i, i + nedKey.length), nedKey) <= 1) return true;
    }
  }
  return false;
}

export function looksIndianPack(rawText: string): boolean {
  return /MFG\.?\s*LIC|MFR\.?\s*LIC|\bRS\.?\b|₹|\bDELHI\b|\bMUMBAI\b|\bINDIA\b|\bIP\b|\bINCL/i.test(rawText);
}

export function hasDollarPrice(value: string): boolean {
  return /\$/.test(value);
}

/** Find the first raw line that fuzzy-contains the value. */
export function findSourceLine(value: string, lines: Array<{ text: string }>): string | null {
  for (const line of lines) {
    if (fuzzyContains(line.text, value)) return line.text;
  }
  const joined = lines.map(l => l.text).join('\n');
  if (fuzzyContains(joined, value)) return collapseSpaces(value);
  return null;
}
