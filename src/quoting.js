/**
 * Volume estimation + pricing engine.
 *
 * Turnover estimates start from a per-category baseline (typical UK
 * independent) and are adjusted by real signals about the specific business
 * and its area:
 *   - region prosperity (ONS-style retail spend patterns by English region /
 *     nation, resolved from the lead's coordinates via postcodes.io)
 *   - local competition density (how many same-category businesses Overpass
 *     found within the search radius — more competitors, smaller share each)
 *   - chain vs independent (OSM brand tag — chains typically outperform)
 *   - opening pattern (7-day and late/24h operations take more per month)
 *
 * Every factor is recorded in `estimateBasis` so staff can see exactly how
 * the number was built and correct it before approving.
 *
 * Pricing policy (set by D&V Partners):
 *   - Absolute floors: 0.4% transaction rate and £15/month terminal rental,
 *     reserved for the highest-volume tier.
 */

/**
 * Category profiles: average DAILY takings (£) for a typical UK independent,
 * trading days/month, and the terminal that fits how they work.
 */
export const CATEGORY_PROFILES = {
  restaurant:   { label: "Restaurant",            avgDaily: 1800, daysOpen: 26, terminal: "Mobile" },
  pub:          { label: "Pub",                   avgDaily: 1600, daysOpen: 30, terminal: "Mobile" },
  bar:          { label: "Bar",                   avgDaily: 1400, daysOpen: 26, terminal: "Mobile" },
  hotel:        { label: "Hotel / B&B",           avgDaily: 2200, daysOpen: 30, terminal: "Countertop" },
  cafe:         { label: "Café / Coffee shop",    avgDaily: 650,  daysOpen: 28, terminal: "Portable" },
  fast_food:    { label: "Takeaway / Fast food",  avgDaily: 900,  daysOpen: 28, terminal: "Countertop" },
  supermarket:  { label: "Supermarket / Grocery", avgDaily: 3200, daysOpen: 30, terminal: "Countertop" },
  convenience:  { label: "Convenience store",     avgDaily: 1100, daysOpen: 30, terminal: "Countertop" },
  pharmacy:     { label: "Pharmacy",              avgDaily: 950,  daysOpen: 26, terminal: "Countertop" },
  bakery:       { label: "Bakery",                avgDaily: 500,  daysOpen: 26, terminal: "Portable" },
  butcher:      { label: "Butcher",               avgDaily: 550,  daysOpen: 26, terminal: "Countertop" },
  greengrocer:  { label: "Greengrocer",           avgDaily: 450,  daysOpen: 26, terminal: "Countertop" },
  clothes:      { label: "Clothing shop",         avgDaily: 600,  daysOpen: 26, terminal: "Countertop" },
  hairdresser:  { label: "Hairdresser / Barber",  avgDaily: 380,  daysOpen: 25, terminal: "Portable" },
  beauty:       { label: "Beauty salon",          avgDaily: 350,  daysOpen: 25, terminal: "Portable" },
  florist:      { label: "Florist",               avgDaily: 300,  daysOpen: 25, terminal: "Countertop" },
  hardware:     { label: "Hardware / DIY",        avgDaily: 700,  daysOpen: 26, terminal: "Countertop" },
  fitness:      { label: "Gym / Fitness",         avgDaily: 450,  daysOpen: 30, terminal: "Countertop" },
  dentist:      { label: "Dental practice",       avgDaily: 1200, daysOpen: 22, terminal: "Countertop" },
  veterinary:   { label: "Veterinary practice",   avgDaily: 1100, daysOpen: 24, terminal: "Countertop" },
  car_repair:   { label: "Garage / MOT",          avgDaily: 900,  daysOpen: 25, terminal: "Portable" },
  other:        { label: "Local business",        avgDaily: 500,  daysOpen: 26, terminal: "Countertop" },
};

/**
 * Regional spend multipliers, keyed by postcodes.io `region` values.
 * Derived from relative household disposable income / retail spend patterns.
 */
export const REGION_MULTIPLIERS = {
  "London": 1.35,
  "South East": 1.15,
  "East of England": 1.05,
  "South West": 1.0,
  "Scotland": 0.97,
  "West Midlands": 0.95,
  "East Midlands": 0.93,
  "North West": 0.92,
  "Yorkshire and The Humber": 0.9,
  "Wales": 0.88,
  "North East": 0.85,
  "Northern Ireland": 0.85,
};

/** Share of takings that go through cards for a typical UK small business. */
const CARD_SHARE = 0.85;

/** Pricing tiers by estimated MONTHLY card turnover. Floors on the top tier. */
export const PRICING_TIERS = [
  { minTurnover: 80000, ratePct: 0.4,  rental: 15, name: "Tier 1 — high volume" },
  { minTurnover: 40000, ratePct: 0.5,  rental: 15, name: "Tier 2" },
  { minTurnover: 20000, ratePct: 0.6,  rental: 18, name: "Tier 3" },
  { minTurnover: 8000,  ratePct: 0.75, rental: 20, name: "Tier 4" },
  { minTurnover: 0,     ratePct: 0.95, rental: 22, name: "Tier 5 — starter" },
];

/** What a typical high-street provider blends out at, for the savings pitch. */
const TYPICAL_COMPETITOR = { ratePct: 1.1, rental: 25 };

/** More same-category competitors nearby → smaller share for each. */
function competitionFactor(count) {
  if (count == null) return { factor: 1, note: "competition unknown" };
  if (count <= 3) return { factor: 1.12, note: `only ${count} similar nearby — strong position` };
  if (count <= 10) return { factor: 1.04, note: `${count} similar nearby — healthy market` };
  if (count <= 25) return { factor: 0.95, note: `${count} similar nearby — competitive area` };
  return { factor: 0.85, note: `${count} similar nearby — crowded market` };
}

/** Crude but explainable opening-hours signal from the OSM opening_hours tag. */
function openingFactor(openingHours) {
  if (!openingHours) return { factor: 1, note: null };
  const oh = openingHours.toLowerCase();
  if (oh.includes("24/7")) return { factor: 1.2, note: "open 24/7" };
  if (/mo-su|su-sa|everyday|daily/.test(oh)) return { factor: 1.08, note: "open 7 days" };
  if (/mo-fr/.test(oh) && !/sa|su/.test(oh)) return { factor: 0.92, note: "weekdays only" };
  return { factor: 1, note: null };
}

/**
 * Estimate monthly card turnover for a business.
 * @param {string} category
 * @param {object} [ctx] { region, district, categoryCount, isChain, openingHours }
 */
export function estimateVolume(category, ctx = {}) {
  const profile = CATEGORY_PROFILES[category] || CATEGORY_PROFILES.other;
  const basis = [];

  const baseMonthly = profile.avgDaily * profile.daysOpen;
  basis.push({
    factor: "Category baseline",
    detail: `${profile.label}: ~£${profile.avgDaily.toLocaleString("en-GB")}/day × ${profile.daysOpen} trading days`,
    effect: `£${baseMonthly.toLocaleString("en-GB")}/mo`,
  });

  let multiplier = 1;

  const regionMult = REGION_MULTIPLIERS[ctx.region] ?? 1;
  if (ctx.region) {
    multiplier *= regionMult;
    basis.push({
      factor: "Local area",
      detail: `${ctx.district ? ctx.district + ", " : ""}${ctx.region}`,
      effect: `×${regionMult.toFixed(2)}`,
    });
  }

  const comp = competitionFactor(ctx.categoryCount);
  if (comp.note) {
    multiplier *= comp.factor;
    basis.push({ factor: "Competition", detail: comp.note, effect: `×${comp.factor.toFixed(2)}` });
  }

  if (ctx.isChain) {
    multiplier *= 1.25;
    basis.push({ factor: "Brand/chain", detail: "recognised brand — typically higher volume", effect: "×1.25" });
  }

  const opening = openingFactor(ctx.openingHours);
  if (opening.note) {
    multiplier *= opening.factor;
    basis.push({ factor: "Opening pattern", detail: opening.note, effect: `×${opening.factor.toFixed(2)}` });
  }

  basis.push({
    factor: "Card share",
    detail: `${Math.round(CARD_SHARE * 100)}% of takings assumed by card`,
    effect: `×${CARD_SHARE}`,
  });

  const monthlyCardTurnover = Math.round((baseMonthly * multiplier * CARD_SHARE) / 10) * 10;

  return {
    monthlyCardTurnover,
    recommendedTerminal: profile.terminal,
    categoryLabel: profile.label,
    estimateBasis: basis,
  };
}

export function priceFor(monthlyCardTurnover) {
  const tier = PRICING_TIERS.find((t) => monthlyCardTurnover >= t.minTurnover);
  // Enforce the business floors defensively even if tiers are edited later.
  return {
    ratePct: Math.max(0.4, tier.ratePct),
    rental: Math.max(15, tier.rental),
    tierName: tier.name,
  };
}

/**
 * Build a full quote for a lead.
 * @param {string} category
 * @param {object} [overrides] manual values from the dashboard
 * @param {object} [ctx] area/business context for the volume estimate
 */
export function buildQuote(category, overrides = {}, ctx = {}) {
  const volume = estimateVolume(category, ctx);
  const monthlyCardTurnover = overrides.monthlyCardTurnover ?? volume.monthlyCardTurnover;
  const pricing = priceFor(monthlyCardTurnover);
  const ratePct = Math.max(0.4, overrides.ratePct ?? pricing.ratePct);
  const rental = Math.max(15, overrides.rental ?? pricing.rental);

  const monthlyProcessing = (monthlyCardTurnover * ratePct) / 100;
  const monthlyTotal = monthlyProcessing + rental;

  const competitorCost = (monthlyCardTurnover * TYPICAL_COMPETITOR.ratePct) / 100 + TYPICAL_COMPETITOR.rental;
  const estMonthlySaving = Math.max(0, Math.round(competitorCost - monthlyTotal));

  const estimateBasis = overrides.monthlyCardTurnover != null
    ? [{ factor: "Manual override", detail: "turnover set by staff in dashboard", effect: `£${Number(overrides.monthlyCardTurnover).toLocaleString("en-GB")}/mo` }]
    : volume.estimateBasis;

  return {
    generatedAt: new Date().toISOString(),
    categoryLabel: volume.categoryLabel,
    monthlyCardTurnover,
    estimateBasis,
    ratePct,
    rental,
    tierName: pricing.tierName,
    recommendedTerminal: overrides.recommendedTerminal ?? volume.recommendedTerminal,
    monthlyProcessing: Math.round(monthlyProcessing),
    monthlyTotal: Math.round(monthlyTotal),
    estMonthlySaving,
    estAnnualSaving: estMonthlySaving * 12,
  };
}

export const money = (n) => `£${Number(n).toLocaleString("en-GB")}`;
