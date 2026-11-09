const NAV_LINE =
  /^(home|menu|search|login|log in|sign in|cookie|cookies|privacy|instagram|facebook|back to top)$/i;

/** Drop chrome lines before a page is shown to a model. */
export function cleanPageText(raw: string): string {
  const lines = raw
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const kept = lines.filter((line) => {
    const bare = line.replace(/[|#>*\-]/g, "").trim();
    if (bare.length < 40 && NAV_LINE.test(bare)) return false;
    if (
      /accept (all )?cookies|we use cookies|one moment, please|request being verified|error establishing a database connection/i.test(
        line,
      )
    ) {
      return false;
    }
    return true;
  });
  return kept.join("\n").trim();
}

/** Lowercase, strip accents, normalize quotes — for tolerant substring checks. */
export function normalizeMatchText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[\u2018\u2019\u201c\u201d\u2032\u2033\u00b4\u0060]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether a research quote appears in page text (strict): exact substring after whitespace collapse.
 * Quote must be at least 8 characters.
 */
export function quoteAppearsIn(quote: string, pageText: string): boolean {
  const needle = quote.replace(/\s+/g, " ").trim();
  if (needle.length < 8) return false;
  return pageText.replace(/\s+/g, " ").includes(needle);
}

/**
 * Evidence validation: same bar as quoteAppearsIn but tolerates case, unicode quotes,
 * optional thousands commas in numbers, and NFKD normalization — so facts still have to
 * appear in the cleaned page, not merely “sound right”.
 */
export function evidenceQuoteMatchesPage(value: string, pageText: string): boolean {
  const cleaned = cleanPageText(pageText);
  const stripWrappingQuotes = (s: string) => s.replace(/^[''\u201c\u201d\u2018\u2019]+|[''\u201c\u201d\u2018\u2019]+$/g, "");
  /** Inner “€45” → €45 (typographic quotes removed for match) */
  const stripInnerQuotes = (s: string) => s.replace(/[''\u2018\u2019\u201c\u201d]/g, "");
  let needle = stripWrappingQuotes(normalizeMatchText(value).replace(/,/g, ""));
  if (needle.length < 3) return false;
  if (needle.length < 8 && !/\d/.test(needle)) return false;
  const hay = stripWrappingQuotes(normalizeMatchText(cleaned).replace(/,/g, ""));
  if (hay.includes(needle)) return true;
  const needleBare = stripInnerQuotes(needle);
  const hayBare = stripInnerQuotes(hay);
  if (needleBare.length >= 3 && hayBare.includes(needleBare)) return true;
  return quoteAppearsIn(value, cleaned);
}
