import type { Resort, ResortPage } from "../types";
import { slugify } from "../mock-data";

export interface SaTpStripStat {
  value: string;
  label: string;
}

export interface SaTpBreakCard {
  tag: string;
  name: string;
  body: string;
  stat: string;
  statSmall: string;
  pill: string;
  time: string;
}

export interface SaTpRateCard {
  label: string;
  amount: string;
  unit: string;
  when: string;
  example?: boolean;
}

export interface SaTpIncItem {
  title: string;
  body: string;
}

export interface SaTpRoomCard {
  title: string;
  body: string;
  bullets: string[];
}

export interface SaTpActItem {
  name: string;
  extra?: boolean;
}

export interface SaTpWhyPoint {
  title: string;
  body: string;
}

export interface SaTpFaqItem {
  q: string;
  a: string;
}

export interface SaTpPageContent {
  slug: string;
  resortName: string;
  location: string;
  metaDescription: string;
  heroHeadline: string;
  heroSub: string;
  strip: SaTpStripStat[];
  wavesHeadline: string;
  wavesLede: string;
  signatureName: string;
  signatureBody: string;
  specs: { label: string; value: string }[];
  breaks: SaTpBreakCard[];
  hasPricing: boolean;
  pricingHeadline: string;
  pricingLede: string;
  rates: SaTpRateCard[];
  pricingFoot: string[];
  includedHeadline: string;
  includedLede: string;
  included: SaTpIncItem[];
  notIncluded: string;
  stayHeadline: string;
  stayLede: string;
  rooms: SaTpRoomCard[];
  activities: SaTpActItem[];
  activitiesLede: string;
  whyHeadline: string;
  whyPoints: SaTpWhyPoint[];
  faqs: SaTpFaqItem[];
  enquireTitle: string;
  enquireBody: string;
  partnerLine: string;
  barPrice: string;
  resortEmail: string;
  showPricingTab: boolean;
}

function pick(r: Resort, key: string): string {
  const f = r.facts.find((x) => x.id.endsWith(`-${key}`));
  const v = f?.selected?.trim();
  if (!v || v.toLowerCase() === "rates on request") return "";
  return v;
}

function splitList(raw: string, max = 8): string[] {
  if (!raw) return [];
  return raw
    .split(/[·•|]\s*|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1)
    .slice(0, max);
}

function firstSentence(s: string, max = 220): string {
  const t = s.trim();
  if (!t) return "";
  const m = t.match(/^[^.!?]+[.!?]?/);
  const one = (m?.[0] ?? t).trim();
  return one.length <= max ? one : `${one.slice(0, max - 1).trim()}…`;
}

function metaFrom(resort: Resort, headline: string, summary: string): string {
  const bits = [headline, summary, resort.name].filter(Boolean);
  const text = bits.join(". ").replace(/\s+/g, " ").trim().slice(0, 155);
  return text.length > 10 ? text : `${resort.name} — surf resort guide from Salt Atlas.`;
}

/** Map verified facts (+ optional writer page) into Telo-shaped page content. */
export function buildSaTpContent(resort: Resort, page?: ResortPage): SaTpPageContent {
  const slug = page?.slug ?? slugify(resort.name);
  const tagline = pick(resort, "tagline");
  const summary = pick(resort, "summary");
  const breakName = pick(resort, "break");
  const waveType = pick(resort, "waveType");
  const season = pick(resort, "season");
  const level = pick(resort, "level");
  const price7 = pick(resort, "price7");
  const inclusions = pick(resort, "inclusions");
  const meals = pick(resort, "meals");
  const rooms = pick(resort, "rooms");
  const capacity = pick(resort, "capacity");
  const airport = pick(resort, "airport");
  const transfer = pick(resort, "transfer");
  const activities = pick(resort, "activities");
  const wellness = pick(resort, "wellness");
  const boards = pick(resort, "boards");
  const photos = pick(resort, "photos");
  const email = pick(resort, "email");

  const location = resort.destination || `${resort.region}, ${resort.country}`.replace(/,\s*$/, "");
  const heroHeadline = breakName || tagline || resort.name;
  const heroSub =
    tagline && breakName && tagline !== breakName
      ? tagline
      : summary
        ? firstSentence(summary, 200)
        : firstSentence(
            [breakName && `Surf at ${breakName}.`, level && `Suited to ${level.toLowerCase()} surfers.`, season && `Best ${season.toLowerCase()}.`]
              .filter(Boolean)
              .join(" "),
            200,
          ) || "Rates, rooms and what’s included — confirmed with the resort before you book.";

  const strip: SaTpStripStat[] = [];
  if (breakName) strip.push({ value: breakName, label: "Primary break" });
  else if (waveType) strip.push({ value: waveType, label: "Wave type" });
  if (capacity) strip.push({ value: capacity.replace(/\s*guests?/i, "").trim() || capacity, label: "Guest capacity" });
  if (season) strip.push({ value: firstSentence(season, 24).replace(/\.$/, ""), label: "Best season" });
  if (airport) strip.push({ value: firstSentence(airport, 20).replace(/\.$/, ""), label: "Nearest airport" });
  if (transfer && strip.length < 4) strip.push({ value: firstSentence(transfer, 24).replace(/\.$/, ""), label: "Transfer" });
  while (strip.length < 4) {
    strip.push({ value: "—", label: "Confirm with resort" });
  }

  const signatureName = breakName || resort.name;
  const signatureBody =
    summary && summary.length > 40
      ? firstSentence(summary, 280)
      : [breakName, waveType, level].filter(Boolean).join(". ") ||
        "Ask Salt Atlas for the latest surf and stay details on the official site.";

  const specs = [
    ...(waveType ? [{ label: "Wave", value: waveType }] : []),
    ...(level ? [{ label: "Level", value: level }] : []),
    ...(season ? [{ label: "Season", value: season }] : []),
    ...(capacity ? [{ label: "Capacity", value: capacity }] : []),
  ].slice(0, 4);
  while (specs.length < 4) specs.push({ label: "Details", value: "On enquiry" });

  const breaks: SaTpBreakCard[] = [];
  if (breakName) {
    breaks.push({
      tag: "01 · Signature",
      name: breakName,
      body: waveType ? `${waveType}. ${level ? `Typically ${level.toLowerCase()}.` : ""}`.trim() : "Primary surf focus for this stay.",
      stat: "On site",
      statSmall: "or nearby",
      pill: waveType || "Surf",
      time: "0",
    });
  }
  for (const extra of splitList(activities, 3)) {
    if (breaks.length >= 6) break;
    breaks.push({
      tag: `${String(breaks.length + 1).padStart(2, "0")} · Nearby`,
      name: extra,
      body: "Confirm access and timing with the resort.",
      stat: "—",
      statSmall: "varies",
      pill: "Ask us",
      time: "15",
    });
  }

  const hasPricing = Boolean(price7);
  const rates: SaTpRateCard[] = hasPricing
    ? [
        {
          label: "Package",
          amount: price7.replace(/^from\s+/i, "").slice(0, 40),
          unit: price7.toLowerCase().includes("night") ? "per night" : "per guest",
          when: "Verified from official source — confirm dates",
        },
      ]
    : [
        {
          label: "Rates",
          amount: "On request",
          unit: "per enquiry",
          when: "We confirm the current package with the resort",
        },
      ];

  const incParts = splitList(inclusions, 6);
  const included: SaTpIncItem[] = incParts.length
    ? incParts.map((title) => ({ title, body: "Included in the package per the resort’s published information." }))
    : [{ title: "Package inclusions", body: inclusions || "Ask us for the resort’s current inclusions list." }];

  const roomParts = splitList(rooms, 3);
  const roomCards: SaTpRoomCard[] = roomParts.length
    ? roomParts.map((title) => ({
        title,
        body: capacity ? `Part of ${capacity} capacity.` : "Confirm layout and amenities with the resort.",
        bullets: ["Ensuite", "Ask about air-con", "Salt Atlas verifies on enquiry"],
      }))
    : rooms
      ? [{ title: rooms.slice(0, 80), body: "Room details from official sources.", bullets: [] }]
      : [{ title: "Room types", body: "We confirm categories and availability when you enquire.", bullets: [] }];

  const actList = [...splitList(activities, 4), ...splitList(wellness, 2)].slice(0, 6);
  const actItems: SaTpActItem[] = actList.length
    ? actList.map((name, i) => ({ name, extra: i > 2 }))
    : [{ name: "Surf-focused stay", extra: false }];

  const whyPoints: SaTpWhyPoint[] = [];
  if (breakName) {
    whyPoints.push({
      title: "The wave is the draw",
      body: `${breakName}${waveType ? ` — ${waveType.toLowerCase()}` : ""}.`,
    });
  }
  if (capacity) whyPoints.push({ title: "Know the scale", body: capacity });
  if (transfer || airport) {
    whyPoints.push({
      title: "Getting there",
      body: [airport, transfer].filter(Boolean).join(" "),
    });
  }
  while (whyPoints.length < 3) {
    whyPoints.push({
      title: whyPoints.length === 0 ? "Salt Atlas pick" : "Verified information",
      body: summary ? firstSentence(summary, 160) : "We quote only what appears on official sources or search evidence.",
    });
  }

  const faqs: SaTpFaqItem[] = [];
  if (boards) faqs.push({ q: "Can I hire boards?", a: boards });
  if (airport) faqs.push({ q: "Which airport do I fly into?", a: airport });
  if (transfer) faqs.push({ q: "How do I get to the resort?", a: transfer });
  if (meals) faqs.push({ q: "What about meals?", a: meals });
  if (photos) faqs.push({ q: "Can I take photos?", a: photos });
  if (price7) faqs.push({ q: "What does the package cost?", a: price7 });
  if (!faqs.length) {
    faqs.push({
      q: "How do I book?",
      a: "Send an enquiry with your dates and group. We check availability with the resort and reply with options.",
    });
  }

  const pricingFoot: string[] = [
    inclusions ? `Included: ${firstSentence(inclusions, 200)}` : "",
    meals ? `Meals: ${firstSentence(meals, 120)}` : "",
    "We confirm the current rate and availability for your dates with every enquiry.",
  ].filter(Boolean);

  return {
    slug,
    resortName: resort.name,
    location,
    metaDescription: metaFrom(resort, heroHeadline, heroSub),
    heroHeadline,
    heroSub,
    strip: strip.slice(0, 4),
    wavesHeadline: "The reason to go",
    wavesLede:
      summary && summary.length > 30
        ? firstSentence(summary, 320)
        : `Surf-focused stay in ${location}. ${level ? `Typically suited to ${level.toLowerCase()} surfers.` : ""}`.trim(),
    signatureName,
    signatureBody,
    specs,
    breaks,
    hasPricing,
    pricingHeadline: hasPricing ? "Published package rate" : "Rates on request",
    pricingLede: hasPricing
      ? "The figure below is quoted from the resort’s own site or package copy. We confirm seasonal validity when you enquire."
      : "The resort did not publish a clear package figure in our last review. Send dates and we’ll get a current quote.",
    rates,
    pricingFoot,
    includedHeadline: "What’s included",
    includedLede: inclusions
      ? firstSentence(inclusions, 200)
      : "From airport to lineup — we map inclusions from the official package page.",
    included,
    notIncluded: boards ? `Board hire: ${boards}` : "Extras such as bar, massage or equipment hire — confirm with the resort.",
    stayHeadline: capacity ? `${capacity}. ${roomParts.length ? `${roomParts.length} room type(s).` : "The stay"}` : "The stay",
    stayLede: rooms
      ? `Accommodation: ${firstSentence(rooms, 180)}`
      : "Room categories and amenities are confirmed on enquiry.",
    rooms: roomCards,
    activities: actItems,
    activitiesLede: activities
      ? firstSentence(activities, 200)
      : wellness
        ? firstSentence(wellness, 200)
        : "Beyond the surf — ask what’s included vs extra.",
    whyHeadline: `Our pick in ${resort.region || resort.country}`,
    whyPoints: whyPoints.slice(0, 3),
    faqs: faqs.slice(0, 8),
    enquireTitle: `Plan your trip to ${resort.region || resort.name}`,
    enquireBody: `Tell us your dates, who’s coming and how you surf. We’ll check availability with ${resort.name} and come back with options. There’s no commitment.`,
    partnerLine: `${resort.name}, ${location}`,
    barPrice: hasPricing ? price7.replace(/^from\s+/i, "").slice(0, 28) : "On request",
    resortEmail: email || "info@saltatlas.com",
    showPricingTab: hasPricing || Boolean(inclusions),
  };
}
