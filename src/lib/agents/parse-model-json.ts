/** Take the first JSON object or array, ignoring notes the model adds after it. */
export function parseModelJson(text: string): unknown {
  let cleaned = text.trim();
  const fenced = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) cleaned = fenced[1].trim();
  const start = cleaned.search(/[{[]/);
  if (start < 0) throw new Error("Claude returned no JSON object.");
  return JSON.parse(balancedSlice(cleaned, start));
}

function balancedSlice(text: string, start: number): string {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error("Claude returned incomplete JSON.");
}
