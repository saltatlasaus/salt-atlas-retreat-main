import { describe, expect, it } from "vitest";
import { parseModelJson } from "./parse-model-json";

describe("parseModelJson", () => {
  it("ignores commentary after the JSON object", () => {
    const body = `${JSON.stringify({ facts: [], readyToDraft: false })}\nHere is a note that is not JSON.`;
    expect(parseModelJson(body)).toEqual({ facts: [], readyToDraft: false });
  });

  it("reads a fenced object and ignores braces inside strings", () => {
    const body = '```json\n{"quote":"use } carefully","ok":true}\n```\n{"second":true}';
    expect(parseModelJson(body)).toEqual({ quote: "use } carefully", ok: true });
  });
});
