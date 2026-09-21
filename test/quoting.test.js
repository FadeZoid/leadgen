import test from "node:test";
import assert from "node:assert/strict";

import {
  CATEGORY_PROFILES,
  PRICING_TIERS,
  REGION_MULTIPLIERS,
  estimateVolume,
  priceFor,
  buildQuote,
  money,
} from "../src/quoting.js";

test("category profiles contain the expected core categories", () => {
  assert.ok(CATEGORY_PROFILES.restaurant);
  assert.ok(CATEGORY_PROFILES.cafe);
  assert.ok(CATEGORY_PROFILES.hairdresser);
  assert.ok(CATEGORY_PROFILES.other);
});

test("category profiles have valid pricing inputs", () => {
  for (const [category, profile] of Object.entries(CATEGORY_PROFILES)) {
    assert.equal(typeof profile.label, "string", `${category} label`);
    assert.ok(profile.avgDaily > 0, `${category} avgDaily`);
    assert.ok(profile.daysOpen > 0, `${category} daysOpen`);
    assert.equal(typeof profile.terminal, "string", `${category} terminal`);
  }
});

test("region multipliers are positive", () => {
  for (const [region, multiplier] of Object.entries(REGION_MULTIPLIERS)) {
    assert.ok(multiplier > 0, `${region} multiplier should be positive`);
  }
});

test("pricing tiers are ordered from highest to lowest turnover", () => {
  for (let i = 1; i < PRICING_TIERS.length; i++) {
    assert.ok(
      PRICING_TIERS[i - 1].minTurnover >= PRICING_TIERS[i].minTurnover,
      "pricing tiers should descend by minimum turnover"
    );
  }
});

test("estimateVolume returns a valid restaurant estimate", () => {
  const result = estimateVolume("restaurant");

  assert.ok(result.monthlyCardTurnover > 0);
  assert.equal(result.categoryLabel, "Restaurant");
  assert.equal(result.recommendedTerminal, "Mobile");
  assert.ok(Array.isArray(result.estimateBasis));
  assert.ok(result.estimateBasis.length > 0);
});

test("estimateVolume falls back to the other category", () => {
  const result = estimateVolume("this-category-does-not-exist");

  assert.equal(result.categoryLabel, CATEGORY_PROFILES.other.label);
  assert.equal(
    result.recommendedTerminal,
    CATEGORY_PROFILES.other.terminal
  );
  assert.ok(result.monthlyCardTurnover > 0);
});

test("regional context changes the estimated turnover", () => {
  const baseline = estimateVolume("cafe");
  const london = estimateVolume("cafe", {
    region: "London",
  });

  assert.ok(london.monthlyCardTurnover > baseline.monthlyCardTurnover);
});

test("chain businesses receive the chain multiplier", () => {
  const independent = estimateVolume("restaurant", {
    region: "South West",
    categoryCount: 10,
  });

  const chain = estimateVolume("restaurant", {
    region: "South West",
    categoryCount: 10,
    isChain: true,
  });

  assert.ok(chain.monthlyCardTurnover > independent.monthlyCardTurnover);
});

test("competition affects the estimate", () => {
  const lowCompetition = estimateVolume("cafe", {
    categoryCount: 2,
  });

  const highCompetition = estimateVolume("cafe", {
    categoryCount: 30,
  });

  assert.ok(
    lowCompetition.monthlyCardTurnover > highCompetition.monthlyCardTurnover
  );
});

test("24/7 businesses receive the opening-hours multiplier", () => {
  const normal = estimateVolume("restaurant");
  const alwaysOpen = estimateVolume("restaurant", {
    openingHours: "24/7",
  });

  assert.ok(alwaysOpen.monthlyCardTurnover > normal.monthlyCardTurnover);
});

test("priceFor selects the highest-volume tier correctly", () => {
  const price = priceFor(100000);

  assert.equal(price.ratePct, 0.4);
  assert.equal(price.rental, 15);
  assert.equal(price.tierName, PRICING_TIERS[0].name);
});

test("priceFor selects the starter tier correctly", () => {
  const price = priceFor(1000);

  assert.equal(price.ratePct, 0.95);
  assert.equal(price.rental, 22);
  assert.equal(price.tierName, "Tier 5 — starter");
});

test("priceFor never violates the business floors", () => {
  const price = priceFor(100000);

  assert.ok(price.ratePct >= 0.4);
  assert.ok(price.rental >= 15);
});

test("buildQuote produces a complete quote", () => {
  const quote = buildQuote("restaurant");

  assert.ok(quote.generatedAt);
  assert.ok(quote.monthlyCardTurnover > 0);
  assert.ok(quote.ratePct >= 0.4);
  assert.ok(quote.rental >= 15);
  assert.ok(quote.monthlyProcessing >= 0);
  assert.ok(quote.monthlyTotal >= quote.rental);
  assert.ok(quote.estMonthlySaving >= 0);
  assert.equal(quote.estAnnualSaving, quote.estMonthlySaving * 12);
});

test("buildQuote respects manual turnover overrides", () => {
  const quote = buildQuote("restaurant", {
    monthlyCardTurnover: 100000,
  });

  assert.equal(quote.monthlyCardTurnover, 100000);
  assert.equal(quote.ratePct, 0.4);
  assert.equal(quote.rental, 15);
  assert.equal(quote.estimateBasis[0].factor, "Manual override");
});

test("buildQuote enforces the minimum rate even when overridden", () => {
  const quote = buildQuote("restaurant", {
    monthlyCardTurnover: 100000,
    ratePct: 0.1,
  });

  assert.equal(quote.ratePct, 0.4);
});

test("buildQuote enforces the minimum rental even when overridden", () => {
  const quote = buildQuote("restaurant", {
    monthlyCardTurnover: 100000,
    rental: 1,
  });

  assert.equal(quote.rental, 15);
});

test("buildQuote allows terminal overrides", () => {
  const quote = buildQuote("restaurant", {
    recommendedTerminal: "Countertop",
  });

  assert.equal(quote.recommendedTerminal, "Countertop");
});

test("money formats GBP values", () => {
  assert.equal(money(1234), "£1,234");
  assert.equal(money(15), "£15");
});