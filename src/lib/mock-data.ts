import type { AppState, Candidate, Category, Competitor, Fact, FactStatus, Resort, SourceUrl } from "./types";

export const COMPETITORS: Competitor[] = [
  { id: "awave", name: "A Wave Travel", domain: "awavetravel.com" },
  { id: "tpw", name: "The Perfect Wave", domain: "perfectwavetravel.com" },
  { id: "worldsurfaris", name: "World Surfaris", domain: "worldsurfaris.com" },
  { id: "waterways", name: "Waterways Travel", domain: "waterwaystravel.com" },
  { id: "wavehunters", name: "Wavehunters", domain: "wavehunters.com" },
  { id: "luex", name: "LUEX", domain: "luex.com" },
  { id: "surfholidays", name: "Surfholidays", domain: "surfholidays.com" },
  { id: "surfari", name: "Surfari", domain: "surfari.com" },
];

export const DESTINATIONS: { country: string; regions: string[] }[] = [
  { country: "Indonesia", regions: ["Mentawai Islands", "Sumbawa", "Bali"] },
  { country: "Sri Lanka", regions: ["South Coast", "Arugam Bay"] },
  { country: "Maldives", regions: ["North Malé Atoll", "Central Atolls"] },
  { country: "Morocco", regions: ["Taghazout", "Imsouane"] },
  { country: "Portugal", regions: ["Ericeira", "Peniche"] },
  { country: "Nicaragua", regions: ["Popoyo", "San Juan del Sur"] },
  { country: "Costa Rica", regions: ["Santa Teresa", "Pavones"] },
];

export interface FieldSpec { key: string; category: Category; label: string; templateField: string }
export const FIELD_SPECS: FieldSpec[] = [
  { key: "tagline", category: "overview", label: "Tagline", templateField: "hero.tagline" },
  { key: "summary", category: "overview", label: "Resort summary", templateField: "overview.body" },
  { key: "break", category: "surf", label: "Primary break", templateField: "surf.items[0]" },
  { key: "waveType", category: "surf", label: "Wave type", templateField: "surf.items[0].meta" },
  { key: "season", category: "surf", label: "Best season", templateField: "surf.season" },
  { key: "level", category: "surf", label: "Ability level", templateField: "surf.level" },
  { key: "rooms", category: "accommodation", label: "Room types", templateField: "accommodation.items" },
  { key: "capacity", category: "accommodation", label: "Guest capacity", templateField: "accommodation.capacity" },
  { key: "price7", category: "pricing", label: "7-night package (pp)", templateField: "pricing.items[0].meta" },
  { key: "inclusions", category: "pricing", label: "Package inclusions", templateField: "pricing.body" },
  { key: "meals", category: "food", label: "Meals", templateField: "food.body" },
  { key: "wellness", category: "food", label: "Wellness", templateField: "food.items" },
  { key: "airport", category: "destination", label: "Nearest airport", templateField: "destination.airport" },
  { key: "transfer", category: "destination", label: "Transfer", templateField: "destination.body" },
  { key: "activities", category: "activities", label: "Activities", templateField: "activities.items" },
  { key: "photos", category: "photography", label: "Photography rights", templateField: "mosaic.license" },
  { key: "boards", category: "faqs", label: "Board hire", templateField: "faq.items[0]" },
  { key: "email", category: "contact", label: "Reservations email", templateField: "enquiry.email" },
];

export const CATEGORY_LABELS: Record<Category, string> = {
  overview: "Resort overview", surf: "Surf", accommodation: "Accommodation", pricing: "Pricing & packages",
  food: "Food & wellness", destination: "Destination & transport", activities: "Activities",
  photography: "Photography", faqs: "FAQs", contact: "Contact details",
};

type Profile = Record<string, string>;

export function baseProfile(r: Pick<Resort, "name" | "region" | "country">): Profile {
  const coast = r.country === "Maldives" ? "atoll" : r.country === "Morocco" || r.country === "Portugal" ? "Atlantic" : "reef";
  return {
    tagline: `Waves first, everything else in good time — ${r.region}.`,
    summary: `${r.name} is a small, surf-focused property in ${r.region}, ${r.country}, positioned within easy reach of the region's best ${coast} breaks.`,
    break: r.country === "Morocco" ? "Anchor Point" : r.country === "Portugal" ? "Ribeira d'Ilhas" : r.country === "Maldives" ? "Sultans" : r.country === "Sri Lanka" ? "Rams Right" : r.country === "Nicaragua" ? "Playa Colorado" : r.country === "Costa Rica" ? "Playa Carmen" : "Telo Left",
    waveType: r.country === "Morocco" ? "Right-hand point break" : "Reef break, left and right",
    season: r.country === "Morocco" || r.country === "Portugal" ? "October – March" : r.country === "Sri Lanka" ? "November – April" : "April – October",
    level: "Intermediate to advanced",
    rooms: "Ocean-view bungalow · Garden double · Twin share",
    capacity: "16 guests",
    price7: "US$2,450",
    inclusions: "7 nights accommodation, three meals daily, boat or vehicle surf transfers, airport transfers",
    meals: "Three daily meals, local seafood and vegetarian menu",
    wellness: "Daily yoga · Massage on request",
    airport: r.country === "Indonesia" ? "Padang (PDG)" : r.country === "Sri Lanka" ? "Colombo (CMB)" : r.country === "Maldives" ? "Velana (MLE)" : r.country === "Morocco" ? "Agadir (AGA)" : r.country === "Portugal" ? "Lisbon (LIS)" : r.country === "Nicaragua" ? "Managua (MGA)" : "Liberia (LIR)",
    transfer: "Private transfer arranged by the resort, included in packages",
    activities: "Snorkelling · Fishing · Island hopping · Surf coaching",
    photos: "Resort-supplied library, licence granted for Salt Atlas use",
    boards: "Quality boards available to hire on site",
    email: `stay@${slugify(r.name)}.com`,
  };
}

export function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

let cid = 0;
const cand = (value: string, sourceUrl: string, sourceType: Candidate["sourceType"], checkedAt = "2026-11-02"): Candidate => ({
  id: `c${++cid}`, value, sourceUrl, sourceType, checkedAt,
});

export interface FactOverride { status: FactStatus; alt?: string; altSource?: string; note?: string }

export function makeFacts(r: Resort, profile: Profile, overrides: Record<string, FactOverride> = {}): Fact[] {
  const official = r.officialUrl ?? `https://${slugify(r.name)}.com`;
  const comp = r.sources.find((s) => s.type === "competitor")?.url ?? `https://worldsurfaris.com/${slugify(r.name)}`;
  return FIELD_SPECS.map((spec) => {
    const value = profile[spec.key] ?? "";
    const o = overrides[spec.key];
    const base = { id: `${r.id}-${spec.key}`, category: spec.category, label: spec.label, templateField: spec.templateField };
    if (o?.status === "missing") return { ...base, candidates: [], status: "missing", reason: o.note ?? "Not found on any scraped source." };
    if (o?.status === "conflict") {
      const a = cand(value, `${official}/packages`, "official");
      const b = cand(o.alt ?? value, o.altSource ?? comp, "competitor");
      return { ...base, extracted: b.value, candidates: [a, b], status: "conflict", reason: o.note ?? "Official site and competitor listing disagree." };
    }
    if (o?.status === "single") {
      const a = cand(value, comp, "competitor");
      return { ...base, extracted: value, selected: value, selectedCandidateId: a.id, candidates: [a], status: "single", reason: "Only a competitor listing supports this value — use cautiously." };
    }
    if (o?.status === "needs_confirmation") {
      const a = cand(value, `${official}/about`, "official", "2025-03-11");
      return { ...base, extracted: value, selected: value, selectedCandidateId: a.id, candidates: [a], status: "needs_confirmation", reason: o.note ?? "Official page is over 18 months old. Confirm with the resort." };
    }
    const a = cand(value, spec.category === "surf" ? "https://saltatlas.com/knowledge/surf" : `${official}/${spec.category}`, spec.category === "surf" ? "salt_atlas" : "official");
    const b = cand(value, comp, "competitor");
    return { ...base, extracted: value, selected: value, selectedCandidateId: a.id, candidates: [a, b], status: "verified", reason: "Official source matches; competitor value consistent but not relied on." };
  });
}

function src(id: string, url: string, type: SourceUrl["type"], competitorId?: string, scrape: SourceUrl["scrape"] = "pending"): SourceUrl {
  return { id, url, type, ...(competitorId ? { competitorId } : {}), selected: true, scrape, ...(scrape === "completed" ? { extractedAt: "2026-11-01 14:22", fieldsFound: 14 } : {}) };
}

function resort(p: Partial<Resort> & Pick<Resort, "id" | "name" | "country" | "region" | "stage" | "competitors">): Resort {
  const official = p.officialUrl ?? `https://${slugify(p.name)}.com`;
  return {
    destination: `${p.region}, ${p.country}`,
    officialUrl: official,
    sources: p.sources ?? [
      src(`${p.id}-o`, official, "official", undefined, p.stage === "scrape" ? "pending" : "completed"),
      ...p.competitors.map((c, i) => {
        const comp = COMPETITORS.find((x) => x.id === c)!;
        return src(`${p.id}-c${i}`, `https://${comp.domain}/${p.country.toLowerCase().replace(/ /g, "-")}/${slugify(p.name)}`, "competitor", c, p.stage === "scrape" ? "pending" : "completed");
      }),
    ],
    facts: [],
    exclusivity: { status: "clear", evidence: [{ note: "No exclusivity statement found on competitor or official pages.", sourceType: "official", url: official }] },
    researchLog: [],
    ...p,
  } as Resort;
}

export function seedState(): AppState {
  const resorts: Resort[] = [];

  const telo = resort({ id: "telo", name: "Telo Reef Lodge", country: "Indonesia", region: "Mentawai Islands", stage: "research", competitors: ["awave", "worldsurfaris", "tpw"], knownBefore: true });
  telo.facts = makeFacts(telo, baseProfile(telo), {
    price7: { status: "conflict", alt: "US$2,180", note: "Official site lists US$2,450 for 2027; World Surfaris shows US$2,180 (likely 2025 rate)." },
    capacity: { status: "missing" },
    airport: { status: "single" },
    wellness: { status: "missing", note: "No wellness information on official site or listings." },
    photos: { status: "needs_confirmation", note: "Resort image licence not yet confirmed in writing." },
  });
  resorts.push(telo);

  const santa = resort({ id: "santa", name: "Santa Teresa Jungle Retreat", country: "Costa Rica", region: "Santa Teresa", stage: "research", competitors: ["luex", "surfholidays"] });
  santa.facts = makeFacts(santa, baseProfile(santa), { season: { status: "conflict", alt: "Year-round", note: "Sources disagree on peak season." }, email: { status: "missing" } });
  santa.exclusivity = { status: "blocked", evidence: [
    { note: "LUEX listing states: “Exclusively bookable through LUEX in Europe.”", url: "https://luex.com/costa-rica/santa-teresa-jungle-retreat", sourceType: "competitor" },
    { note: "Resort booking page redirects European enquiries to LUEX.", url: "https://santa-teresa-jungle-retreat.com/book", sourceType: "official" },
  ] };
  resorts.push(santa);

  const weligama = resort({ id: "weligama", name: "Weligama Point House", country: "Sri Lanka", region: "South Coast", stage: "generate", competitors: ["surfholidays", "awave"] });
  weligama.facts = makeFacts(weligama, baseProfile(weligama));
  resorts.push(weligama);

  const thulus = resort({ id: "thulus", name: "Thulusdhoo Reef Villas", country: "Maldives", region: "North Malé Atoll", stage: "generate", competitors: ["worldsurfaris", "waterways", "tpw"] });
  thulus.facts = makeFacts(thulus, { ...baseProfile(thulus), price7: "US$3,890", rooms: "Beach villa · Lagoon suite" }, { photos: { status: "needs_confirmation" } });
  thulus.exclusivity = { status: "needs_review", evidence: [{ note: "Waterways describes the property as a “preferred partner” — not explicitly exclusive.", url: "https://waterwaystravel.com/maldives/thulusdhoo-reef-villas", sourceType: "competitor" }] };
  resorts.push(thulus);

  const anchor = resort({ id: "anchor", name: "Anchor Bay Surf House", country: "Morocco", region: "Taghazout", stage: "published", competitors: ["surfholidays", "luex"] });
  anchor.facts = makeFacts(anchor, { ...baseProfile(anchor), price7: "€1,190" });
  resorts.push(anchor);

  const ericeira = resort({ id: "ericeira", name: "Ericeira Atlantic Lodge", country: "Portugal", region: "Ericeira", stage: "scrape", competitors: ["surfholidays", "luex", "wavehunters"] });
  resorts.push(ericeira);
  const popoyo = resort({ id: "popoyo", name: "Popoyo Sands Camp", country: "Nicaragua", region: "Popoyo", stage: "scrape", competitors: ["tpw", "waterways"] });
  resorts.push(popoyo);

  const hiri = resort({ id: "hiri", name: "Hiriketiya Bay Lodge", country: "Sri Lanka", region: "South Coast", stage: "discover", competitors: ["awave"] });
  resorts.push(hiri);

  return { competitors: COMPETITORS, resorts, discoveryResults: [] };
}

/** Mock discovery output, deterministic per destination. */
export function mockDiscovery(country: string, region: string, competitorIds: string[], knownNames: string[]): Resort[] {
  const pools: Record<string, string[]> = {
    Indonesia: ["Siberut Point Camp", "Playgrounds Reef Resort", "Playgrounds Reef Resort & Spa", "Telo Reef Lodge", "Macaronis Bay Villas", "Nyang Nyang Island Camp"],
    "Sri Lanka": ["Midigama Wave House", "Hiriketiya Bay Lodge", "Arugam Point Cabanas", "Ahangama Surf Villa"],
    Maldives: ["Himmafushi Surf Retreat", "Jailbreaks Island Resort", "Thulusdhoo Reef Villas", "Lohis Atoll Lodge"],
    Morocco: ["Imsouane Bay Riad", "Killer Point Surf House", "Anchor Bay Surf House", "Tamraght Roof Lodge"],
    Portugal: ["Coxos Cliff House", "Peniche Supertubos Lodge", "Ericeira Atlantic Lodge"],
    Nicaragua: ["Colorado Point Lodge", "Popoyo Sands Camp", "Rancho Santana Surf Villas"],
    "Costa Rica": ["Pavones Left Lodge", "Santa Teresa Jungle Retreat", "Playa Hermosa Surf Camp"],
  };
  const comps = competitorIds.length ? competitorIds : COMPETITORS.slice(0, 3).map((c) => c.id);
  const names = pools[country] ?? pools["Indonesia"] ?? [];
  return names.map((name, i) => {
    const listedBy = comps.filter((_, j) => (i + j) % 2 === 0 || j === 0).slice(0, 3);
    const id = `d-${slugify(name)}`;
    const r = resort({ id, name, country, region, stage: "discover", competitors: listedBy, knownBefore: knownNames.includes(name) });
    r.sources = [
      ...listedBy.map((c, k) => {
        const comp = COMPETITORS.find((x) => x.id === c) ?? { domain: `${c}.com` };
        return src(`${id}-c${k}`, `https://${comp.domain}/${country.toLowerCase().replace(/ /g, "-")}/${slugify(name)}`, "competitor", c);
      }),
      src(`${id}-o`, `https://${slugify(name)}.com`, "official"),
      src(`${id}-r`, `https://instagram.com/${slugify(name).replace(/-/g, "")}`, "resort_owned"),
      src(`${id}-i`, `https://surf-forecast.com/breaks/${slugify(region)}`, "independent"),
    ];
    r.sources.forEach((s) => (s.selected = s.type === "official" || s.type === "competitor"));
    if (name.endsWith("& Spa")) {
      r.duplicateOf = `d-${slugify(name.replace(" & Spa", ""))}`;
      r.identityNote = "Similar name to Playgrounds Reef Resort, but different official domain and coordinates 4.2 km apart — kept separate pending review.";
    }
    return r;
  });
}
