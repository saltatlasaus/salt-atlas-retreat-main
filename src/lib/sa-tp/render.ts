import type { Resort, ResortPage } from "../types";
import { buildSaTpContent, type SaTpPageContent } from "./build-content";
import { SA_TP_INC_SVGS, SA_TP_WAVE_SVG } from "./icons";
import saTpCss from "./sa-tp.css?raw";
import saTpJs from "./sa-tp.js?raw";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function e(s: string): string {
  return escapeHtml(s);
}

function stripLi(c: SaTpPageContent, i: number): string {
  const s = c.strip[i];
  if (!s) return "";
  return `<li data-sa-field="strip.${i}"><b>${e(s.value)}</b><span>${e(s.label)}</span></li>`;
}

function breakCards(c: SaTpPageContent): string {
  if (!c.breaks.length) {
    return `<article class="sa-tp-brk" data-time="0"><span class="sa-tp-label">01 · Surf</span><h3>${e(c.signatureName)}</h3><p>${e(c.signatureBody)}</p><div class="sa-tp-brk-foot"><span><b>—</b><small>confirm</small></span><span class="sa-tp-pill">Surf</span></div></article>`;
  }
  return c.breaks
    .map(
      (b, i) => `<article class="sa-tp-brk" data-time="${e(b.time)}" data-sa-field="waves.breaks.${i}">
          <span class="sa-tp-label">${e(b.tag)}</span>
          <h3>${e(b.name)}</h3>
          <p>${e(b.body)}</p>
          <div class="sa-tp-brk-foot"><span><b>${e(b.stat)}</b><small>${e(b.statSmall)}</small></span><span class="sa-tp-pill">${e(b.pill)}</span></div>
        </article>`,
    )
    .join("\n        ");
}

function specsGrid(c: SaTpPageContent): string {
  return c.specs
    .map((s) => `<div class="sa-tp-spec"><b>${e(s.label)}</b><span>${e(s.value)}</span></div>`)
     
    .join("\n            ");
}

function rates(c: SaTpPageContent): string {
  return c.rates
    .map(
      (r, i) => `<article class="sa-tp-rate${r.example ? " is-example" : ""}" data-sa-field="pricing.rates.${i}">
          <span class="sa-tp-label">${e(r.label)}</span>
          <div class="sa-tp-rate-num">${e(r.amount)}</div>
          <div class="sa-tp-rate-unit">${e(r.unit)}</div>
          <p class="sa-tp-rate-when">${e(r.when)}</p>
        </article>`,
    )
    .join("\n        ");
}

function included(c: SaTpPageContent): string {
  return c.included
    .map((item, i) => {
      const svg = SA_TP_INC_SVGS[i % SA_TP_INC_SVGS.length];
      return `<div class="sa-tp-inc-item" data-sa-field="included.items.${i}">
          ${svg}
          <h3>${e(item.title)}</h3>
          <p>${e(item.body)}</p>
        </div>`;
    })
    .join("\n        ");
}

function stayCards(c: SaTpPageContent): string {
  return c.rooms
    .map(
      (room, i) => `<article class="sa-tp-stay" data-sa-field="stay.rooms.${i}">
          <div class="sa-tp-media" data-ph="Photo · ${e(room.title)}"><img src="" alt="${e(room.title)}"></div>
          <div class="sa-tp-stay-body">
            <h3>${e(room.title)}</h3>
            <p>${e(room.body)}</p>
            ${room.bullets.length ? `<ul>${room.bullets.map((b) => `<li>${e(b)}</li>`).join("")}</ul>` : ""}
            <a class="sa-tp-stay-cta" href="#enquire" data-stay="${e(room.title)}">Enquire about this room ›</a>
          </div>
        </article>`,
    )
    .join("\n        ");
}

function activities(c: SaTpPageContent): string {
  return c.activities
    .map(
      (a, i) =>
        `<div class="sa-tp-act${a.extra ? " is-extra" : ""}" data-sa-field="activities.items.${i}"><span class="sa-tp-label">${a.extra ? "Extra" : "Included"}</span><b>${e(a.name)}</b></div>`,
    )
    .join("\n        ");
}

function why(c: SaTpPageContent): string {
  return c.whyPoints
    .map(
      (p, i) => `<div data-sa-field="why.points.${i}">
          <span class="sa-tp-why-n">${String(i + 1).padStart(2, "0")}</span>
          <h3>${e(p.title)}</h3>
          <p>${e(p.body)}</p>
        </div>`,
    )
    .join("\n        ");
}

function faqColumns(c: SaTpPageContent): string {
  const mid = Math.ceil(c.faqs.length / 2);
  const col = (items: typeof c.faqs) =>
    items.map((f) => `<details><summary>${e(f.q)}</summary><p>${e(f.a)}</p></details>`).join("\n          ");
  return `<div>
          ${col(c.faqs.slice(0, mid))}
        </div>
        <div>
          ${col(c.faqs.slice(mid))}
        </div>`;
}

function roomChips(c: SaTpPageContent): string {
  const rooms = c.rooms.map((r) => r.title);
  const opts = [...rooms, "Not sure, recommend one"];
  return opts
    .map((title) => {
      const checked = title === "Not sure, recommend one" ? ' checked=""' : "";
      const label = title === "Not sure, recommend one" ? "Not sure yet" : title;
      return `<label><input type="radio" name="stay" value="${e(title)}"${checked}><span>${e(label)}</span></label>`;
    })
    .join("\n              ");
}

function renderBody(c: SaTpPageContent, resort: Resort): string {
  const formName = `resort-enquiry-${c.slug}`;
  const pricingLink = c.showPricingTab ? `\n        <a class="sa-tp-link" href="#sa-tp-pricing">See prices ›</a>` : "";
  const pricingTab = c.showPricingTab ? `\n      <li><a href="#sa-tp-pricing">Pricing</a></li>` : "";
  const barPriceInner = c.hasPricing
    ? `<span class="sa-tp-bar-extra">Package · </span>From<b>${e(c.barPrice)}</b>per guest / night`
    : `<b>${e(c.barPrice)}</b>`;

  return `<!-- SALT ATLAS · RESORT PAGE · ${e(c.slug)} · generated from verified facts · edit data in Studio, re-export -->
<div class="sa-tp" id="sa-tp" data-sa-resort="${e(c.slug)}">

  <header class="sa-tp-hero sa-tp-media" data-sa-section="hero" data-ph="Hero photo · ${e(c.heroHeadline)} · landscape · resort-supplied">
    <img src="" alt="${e(c.resortName)}">
    <div class="sa-tp-hero-in">
      <div class="sa-tp-eyebrow" data-sa-field="location">${e(c.location)}</div>
      <h1 data-sa-field="hero.headline">${e(c.heroHeadline)}</h1>
      <p class="sa-tp-hero-sub" data-sa-field="hero.sub">${e(c.heroSub)}</p>
      <div class="sa-tp-hero-ctas">
        <a class="sa-tp-btn sa-tp-btn-ghost" href="#enquire">Enquire now <span aria-hidden="true">›</span></a>
        <a class="sa-tp-link" href="#sa-tp-waves">See the waves ›</a>${pricingLink}
      </div>
    </div>
    <div class="sa-tp-partner">
      <span class="sa-tp-label">Stay at</span>
      <span class="sa-tp-partner-name" data-sa-field="name">${e(c.resortName)}</span>
    </div>
  </header>

  <div class="sa-tp-strip" data-sa-section="strip">
    <ul>
      ${[0, 1, 2, 3].map((i) => stripLi(c, i)).join("\n      ")}
    </ul>
  </div>

  <nav class="sa-tp-tabs" aria-label="On this page">
    <ul>
      <li><a href="#sa-tp-waves">The waves</a></li>${pricingTab}
      <li><a href="#sa-tp-included">What’s included</a></li>
      <li><a href="#sa-tp-stay">The stay</a></li>
      <li><a href="#sa-tp-faq">Good to know</a></li>
      <li><a href="#enquire">Enquire</a></li>
    </ul>
  </nav>

  <section class="sa-tp-sec" id="sa-tp-waves" data-sa-section="waves">
    <div class="sa-tp-wrap">
      <div class="sa-tp-head-row">
        <div>
          <div class="sa-tp-eyebrow">01 · The waves</div>
          <h2 data-sa-field="waves.headline">${e(c.wavesHeadline)}</h2>
          <p class="sa-tp-lede" data-sa-field="waves.lede">${e(c.wavesLede)}</p>
        </div>
        <a class="sa-tp-link" href="#enquire" data-interest="Advice on the breaks">Ask us what suits your level ›</a>
      </div>

      <div class="sa-tp-feature sa-tp-on-dark" data-sa-field="waves.signature">
        <div class="sa-tp-feature-text">
          <div class="sa-tp-eyebrow">Signature break</div>
          <h2>${e(c.signatureName)}</h2>
          <p>${e(c.signatureBody)}</p>
          <div class="sa-tp-specs">
            ${specsGrid(c)}
          </div>
          <a class="sa-tp-btn sa-tp-btn-ghost" href="#enquire" data-interest="Advice on the breaks">Enquire about the surf <span aria-hidden="true">›</span></a>
        </div>
        <div class="sa-tp-media" data-ph="Photo · ${e(c.signatureName)} · resort-supplied">
          ${SA_TP_WAVE_SVG}
          <img src="" alt="${e(c.signatureName)}">
        </div>
      </div>

      <div class="sa-tp-subhead">
        <div>
          <div class="sa-tp-eyebrow">Every break</div>
          <h2>Choose your line</h2>
        </div>
        <div class="sa-tp-filters" role="group" aria-label="Filter breaks by distance">
          <button type="button" class="sa-tp-filter is-on" data-filter="all">All breaks</button>
          <button type="button" class="sa-tp-filter" data-filter="paddle">Paddle out</button>
          <button type="button" class="sa-tp-filter" data-filter="near">10 min or less</button>
          <button type="button" class="sa-tp-filter" data-filter="far">15 min+</button>
        </div>
      </div>
      <div class="sa-tp-breaks">
        ${breakCards(c)}
      </div>
      <p class="sa-tp-note">Break details come from the resort’s published information. Conditions vary — tell us how you surf and we’ll say what’s realistic.</p>
    </div>
  </section>

  <section class="sa-tp-sec sa-tp-pricing sa-tp-on-dark" id="sa-tp-pricing" data-sa-section="pricing">
    <div class="sa-tp-wrap">
      <div class="sa-tp-head-row">
        <div>
          <div class="sa-tp-eyebrow">02 · Pricing</div>
          <h2 data-sa-field="pricing.headline">${e(c.pricingHeadline)}</h2>
          <p class="sa-tp-lede" data-sa-field="pricing.lede">${e(c.pricingLede)}</p>
        </div>
      </div>
      <div class="sa-tp-rates">
        ${rates(c)}
      </div>
      <div class="sa-tp-price-ex">
        ${c.pricingFoot.map((p) => `<p>${e(p)}</p>`).join("\n        ")}
      </div>
      <div class="sa-tp-price-cta">
        <a class="sa-tp-btn sa-tp-btn-white" href="#enquire">Get a quote for your dates <span aria-hidden="true">›</span></a>
      </div>
    </div>
  </section>

  <section class="sa-tp-sec" id="sa-tp-included" data-sa-section="included">
    <div class="sa-tp-wrap">
      <div class="sa-tp-head">
        <div class="sa-tp-eyebrow">03 · What’s included</div>
        <h2>${e(c.includedHeadline)}</h2>
        <p class="sa-tp-lede">${e(c.includedLede)}</p>
      </div>
      <div class="sa-tp-inc">
        ${included(c)}
      </div>
      <p class="sa-tp-notinc"><b>Not included:</b> ${e(c.notIncluded)}</p>
    </div>
  </section>

  <section class="sa-tp-sec" id="sa-tp-stay" data-sa-section="stay" style="background:var(--surface);">
    <div class="sa-tp-wrap">
      <div class="sa-tp-head-row">
        <div>
          <div class="sa-tp-eyebrow">04 · The stay</div>
          <h2 data-sa-field="stay.headline">${e(c.stayHeadline)}</h2>
          <p class="sa-tp-lede" data-sa-field="stay.lede">${e(c.stayLede)}</p>
        </div>
        <a class="sa-tp-link" href="#enquire">Not sure which? Ask us ›</a>
      </div>
      <div class="sa-tp-stays">
        ${stayCards(c)}
      </div>
      <div class="sa-tp-mosaic" aria-label="Photos">
        <div class="sa-tp-media sa-tp-m-a" data-ph="Photo" tabindex="0" role="button"><img src="" alt="${e(c.resortName)}, photo 1"></div>
        <div class="sa-tp-media sa-tp-m-b" data-ph="Photo" tabindex="0" role="button"><img src="" alt="${e(c.resortName)}, photo 2"></div>
        <div class="sa-tp-media sa-tp-m-c" data-ph="Photo" tabindex="0" role="button"><img src="" alt="${e(c.resortName)}, photo 3"></div>
        <div class="sa-tp-media sa-tp-m-d" data-ph="Photo" tabindex="0" role="button"><img src="" alt="${e(c.resortName)}, photo 4"></div>
      </div>
      <div class="sa-tp-extra" hidden=""></div>
      <div class="sa-tp-more"><button type="button" data-sa-tp-gallery="">See all photos ›</button></div>
    </div>
  </section>

  <section class="sa-tp-sec" id="sa-tp-explore" data-sa-section="activities">
    <div class="sa-tp-wrap">
      <div class="sa-tp-head">
        <div class="sa-tp-eyebrow">Between sessions</div>
        <h2>Off the water</h2>
        <p class="sa-tp-lede">${e(c.activitiesLede)}</p>
      </div>
      <div class="sa-tp-acts">
        ${activities(c)}
      </div>
    </div>
  </section>

  <section class="sa-tp-sec is-tight" data-sa-section="why">
    <div class="sa-tp-wrap">
      <div class="sa-tp-head">
        <div class="sa-tp-eyebrow">Why we send guests here</div>
        <h2>${e(c.whyHeadline)}</h2>
      </div>
      <div class="sa-tp-why">
        ${why(c)}
      </div>
    </div>
  </section>

  <section class="sa-tp-sec" id="sa-tp-faq" data-sa-section="faq">
    <div class="sa-tp-wrap">
      <div class="sa-tp-head">
        <div class="sa-tp-eyebrow">Good to know</div>
        <h2>Before you book</h2>
      </div>
      <div class="sa-tp-faq">
        ${faqColumns(c)}
      </div>
    </div>
  </section>

  <section class="sa-tp-enq sa-tp-on-dark" id="enquire" data-sa-section="enquire">
    <div class="sa-tp-wrap sa-tp-enq-grid">
      <div class="sa-tp-enq-intro">
        <div class="sa-tp-eyebrow">Enquire</div>
        <h2>${e(c.enquireTitle)}</h2>
        <p>${e(c.enquireBody)}</p>
        <ol class="sa-tp-steps">
          <li><b>01</b><span>Send your dates and group</span></li>
          <li><b>02</b><span>We check availability with the resort</span></li>
          <li><b>03</b><span>We reply with options and next steps</span></li>
        </ol>
        <p class="sa-tp-enq-alt">Prefer email? <a href="mailto:${e(c.resortEmail)}?subject=${encodeURIComponent(c.resortName + " enquiry")}">${e(c.resortEmail)}</a></p>
      </div>
      <div class="sa-tp-formcard">
        <form class="sa-tp-form" name="${e(formName)}" method="POST" data-endpoint="/" novalidate="">
          <input type="hidden" name="form-name" value="${e(formName)}">
          <input type="hidden" name="partner" value="${e(c.partnerLine)}">
          <input type="hidden" name="page" value="">
          <input type="hidden" name="utm_source" value=""><input type="hidden" name="utm_medium" value=""><input type="hidden" name="utm_campaign" value="">
          <p class="sa-tp-hp" aria-hidden="true"><label>Leave this empty <input name="bot-field" tabindex="-1" autocomplete="off"></label></p>
          <div class="sa-tp-row">
            <label class="sa-tp-field"><span class="sa-tp-flabel">Name <i>*</i></span><input type="text" name="name" autocomplete="name" required=""></label>
            <label class="sa-tp-field"><span class="sa-tp-flabel">Email <i>*</i></span><input type="email" name="email" autocomplete="email" required=""></label>
          </div>
          <div class="sa-tp-row">
            <label class="sa-tp-field"><span class="sa-tp-flabel">Phone or WhatsApp</span><input type="tel" name="phone" autocomplete="tel"></label>
            <label class="sa-tp-field"><span class="sa-tp-flabel">Arrival date <i>*</i></span><input type="date" name="arrival" required=""></label>
          </div>
          <div class="sa-tp-row is-3">
            <label class="sa-tp-field"><span class="sa-tp-flabel">Nights <i>*</i></span>
              <select name="nights" required=""><option value="">Select</option><option>5</option><option>6</option><option>7</option><option>8</option><option>9</option><option>10</option><option>11</option><option>12+</option><option>Not sure yet</option></select></label>
            <label class="sa-tp-field"><span class="sa-tp-flabel">Surfers <i>*</i></span>
              <select name="adults" required=""><option value="">Select</option><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option><option>6</option><option>7</option><option>8</option><option>9</option></select></label>
            <label class="sa-tp-field"><span class="sa-tp-flabel">Non-surfers</span>
              <select name="non_surfers"><option>0</option><option>1</option><option>2</option><option>3</option><option>4+</option></select></label>
          </div>
          <fieldset class="sa-tp-field">
            <legend class="sa-tp-flabel">Which room?</legend>
            <div class="sa-tp-chips-in">
              ${roomChips(c)}
            </div>
          </fieldset>
          <fieldset class="sa-tp-field">
            <legend class="sa-tp-flabel">Your surfing</legend>
            <div class="sa-tp-chips-in">
              <label><input type="radio" name="surf_level" value="Beginner"><span>Beginner</span></label>
              <label><input type="radio" name="surf_level" value="Intermediate"><span>Intermediate</span></label>
              <label><input type="radio" name="surf_level" value="Advanced"><span>Advanced</span></label>
              <label><input type="radio" name="surf_level" value="Expert, chasing barrels"><span>Chasing barrels</span></label>
            </div>
          </fieldset>
          <fieldset class="sa-tp-field">
            <legend class="sa-tp-flabel">Interested in <em>(pick any)</em></legend>
            <div class="sa-tp-chips-in">
              <label><input type="checkbox" name="interests" value="Advice on the breaks"><span>Advice on the breaks</span></label>
              <label><input type="checkbox" name="interests" value="Board rental"><span>Board rental</span></label>
              <label><input type="checkbox" name="interests" value="Massage"><span>Massage</span></label>
              <label><input type="checkbox" name="interests" value="Fishing and snorkelling"><span>Fishing and snorkelling</span></label>
            </div>
          </fieldset>
          <label class="sa-tp-field"><span class="sa-tp-flabel">Anything else?</span><textarea name="message" rows="3" placeholder="Flexible dates, waves you’re chasing, dietary needs..."></textarea></label>
          <label class="sa-tp-consent"><input type="checkbox" name="consent" value="yes" checked=""><span>I’m happy for Salt Atlas to contact me about this enquiry.</span></label>
          <button type="submit" class="sa-tp-btn sa-tp-btn-navy sa-tp-submit">Send enquiry <span aria-hidden="true">›</span></button>
          <p class="sa-tp-formnote">By sending this enquiry you agree to Salt Atlas contacting you about it. To opt out, untick the box before you send.</p>
          <p class="sa-tp-formerr" role="alert" hidden=""></p>
        </form>
        <div class="sa-tp-thanks" hidden="" tabindex="-1">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg>
          <h3>Thanks, your enquiry is in</h3>
          <p>We’ll check availability with ${e(c.resortName)} and come back to you by email soon. Check your spam folder just in case.</p>
        </div>
      </div>
    </div>
  </section>

  <div class="sa-tp-bar" aria-hidden="true">
    <div class="sa-tp-bar-in">
      <div class="sa-tp-bar-trip">${e(c.resortName)} · ${e(resort.region || resort.country)}</div>
      <div class="sa-tp-bar-right">
        <div class="sa-tp-bar-price">${barPriceInner}</div>
        <a class="sa-tp-btn sa-tp-btn-navy" href="#enquire" tabindex="-1">Enquire now <span aria-hidden="true">›</span></a>
      </div>
    </div>
  </div>

  <div class="sa-tp-lb" role="dialog" aria-modal="true" aria-label="Photo gallery">
    <img src="" alt="">
    <button type="button" class="sa-tp-lb-x" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"></path></svg></button>
    <button type="button" class="sa-tp-lb-prev" aria-label="Previous photo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"></path></svg></button>
    <button type="button" class="sa-tp-lb-next" aria-label="Next photo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"></path></svg></button>
    <div class="sa-tp-lb-count"></div>
  </div>
</div>`;
}

/** Full `.sa-tp` document matching the Salt Atlas destinations resort template (Telo reference). */
export function resortToSaTpHtml(resort: Resort, page?: ResortPage): string {
  const c = buildSaTpContent(resort, page);
  const title = `${c.resortName} — ${c.heroHeadline} | Salt Atlas`;
  const body = renderBody(c, resort);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${e(c.metaDescription)}">
<meta name="robots" content="noindex, nofollow">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="">
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&amp;family=IBM+Plex+Mono:wght@400;500&amp;display=swap" rel="stylesheet">
<style>${saTpCss}</style>
</head>
<body>
${body}
<script>
${saTpJs}
</script>
</body>
</html>`;
}
