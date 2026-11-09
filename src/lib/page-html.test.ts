import { describe, expect, it } from "vitest";
import { resortPageToStaticHtml } from "./page-html";
import type { Resort, ResortPage } from "./types";

describe("resortPageToStaticHtml", () => {
  it("renders .sa-tp template and escapes HTML", () => {
    const resort = {
      id: "x",
      name: "Test & <Resort>",
      country: "PT",
      region: "Ericeira",
      destination: "Ericeira",
      facts: [
        { id: "x-break", selected: 'Ribeira <script>alert(1)</script>', options: [] },
        { id: "x-tagline", selected: "Surf & stay", options: [] },
      ],
    } as Resort;
    const page: ResortPage = {
      sections: [],
      title: "T | Salt Atlas",
      slug: "pt/test-resort",
      status: "draft",
      versions: [],
      history: [],
      pendingFactChanges: [],
    };
    const html = resortPageToStaticHtml(resort, page);
    expect(html).toContain('class="sa-tp"');
    expect(html).toContain('id="sa-tp-waves"');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/<script[^>]*alert/);
    expect(html).toContain("Test &amp; &lt;Resort&gt;");
    expect(html).toContain('data-sa-resort="pt/test-resort"');
  });
});
