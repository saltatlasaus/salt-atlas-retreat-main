import type { Resort, ResortPage } from "./types";
import { resortToSaTpHtml } from "./sa-tp";

/** Standalone `.sa-tp` HTML — same shell as salt-atlas-destinations resort pages. */
export function resortPageToStaticHtml(resort: Resort, page?: ResortPage): string {
  return resortToSaTpHtml(resort, page);
}
