/**
 * Business discovery via OpenStreetMap.
 *   1. Geocode a UK place name/postcode (postcodes.io for postcodes, Nominatim otherwise).
 *   2. Query Overpass in small sequential batches. Overpass allows only 2
 *      concurrent slots per IP and kills big combined queries on dense areas
 *      (a single query with all 22 categories times out on e.g. Oldham), so we
 *      run batches of ~6 tags one at a time and stop once we have enough.
 *   3. Look up the local authority + region for the area so the quoting engine
 *      can weight turnover estimates by local economy.
 */

const UA = "DVPartners-LeadGen/1.0 (merchant services outreach; contact: rafi@dvpartners.org)";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

/** OSM tag → internal category. Order = search priority (high-value types first). */
const TAG_MAP = [
  { key: "amenity", value: "restaurant", category: "restaurant" },
  { key: "amenity", value: "pub", category: "pub" },
  { key: "amenity", value: "cafe", category: "cafe" },
  { key: "amenity", value: "fast_food", category: "fast_food" },
  { key: "shop", value: "convenience", category: "convenience" },
  { key: "shop", value: "supermarket", category: "supermarket" },
  { key: "amenity", value: "bar", category: "bar" },
  { key: "shop", value: "hairdresser", category: "hairdresser" },
  { key: "shop", value: "beauty", category: "beauty" },
  { key: "amenity", value: "pharmacy", category: "pharmacy" },
  { key: "shop", value: "bakery", category: "bakery" },
  { key: "shop", value: "butcher", category: "butcher" },
  { key: "tourism", value: "hotel", category: "hotel" },
  { key: "amenity", value: "dentist", category: "dentist" },
  { key: "amenity", value: "veterinary", category: "veterinary" },
  { key: "shop", value: "clothes", category: "clothes" },
  { key: "shop", value: "greengrocer", category: "greengrocer" },
  { key: "shop", value: "florist", category: "florist" },
  { key: "shop", value: "hardware", category: "hardware" },
  { key: "shop", value: "doityourself", category: "hardware" },
  { key: "shop", value: "car_repair", category: "car_repair" },
  { key: "leisure", value: "fitness_centre", category: "fitness" },
];

export const DISCOVERABLE_CATEGORIES = [...new Set(TAG_MAP.map((t) => t.category))];

/** Normalise UK postcodes: "OL81QN" → "OL8 1QN" so geocoders find them reliably. */
export function normalizePlace(place) {
  const trimmed = place.trim();
  const compact = trimmed.replace(/\s+/g, "").toUpperCase();
  const m = compact.match(/^([A-Z]{1,2}\d{1,2}[A-Z]?)(\d[A-Z]{2})$/);
  if (m) return `${m[1]} ${m[2]}`;
  return trimmed;
}

function isPostcode(place) {
  return /^[A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2}$/i.test(normalizePlace(place));
}

async function geocodePostcodesIo(postcode) {
  const compact = postcode.replace(/\s+/g, "");
  const res = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(compact)}`, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.status !== 200 || !data.result) return null;
  const r = data.result;
  return {
    lat: r.latitude,
    lon: r.longitude,
    displayName: `${r.postcode}, ${r.admin_district || r.region || "UK"}`,
    region: r.region || null,
    district: r.admin_district || null,
  };
}

/** Reverse lookup: nearest postcode to a lat/lon → region + district. */
export async function lookupArea(lat, lon) {
  try {
    const res = await fetch(`https://api.postcodes.io/postcodes?lon=${lon}&lat=${lat}&limit=1`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const r = data.result?.[0];
    if (!r) return null;
    return { region: r.region || null, district: r.admin_district || null };
  } catch {
    return null;
  }
}

export async function geocode(place) {
  const normalized = normalizePlace(place);

  if (isPostcode(place)) {
    const pc = await geocodePostcodesIo(normalized);
    if (pc) return pc;
  }

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", normalized);
  url.searchParams.set("countrycodes", "gb");
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
  const results = await res.json();
  if (!results.length) throw new Error(`Couldn't find "${place}" — try a town name or postcode like "OL8 1QN".`);
  const geo = {
    lat: Number(results[0].lat),
    lon: Number(results[0].lon),
    displayName: results[0].display_name,
    region: null,
    district: null,
  };
  const area = await lookupArea(geo.lat, geo.lon);
  if (area) Object.assign(geo, area);
  return geo;
}

/**
 * One regex clause per OSM key (amenity/shop/tourism/leisure) instead of one
 * clause per value — Overpass evaluates this in a single pass over the area,
 * which is far faster than 22 separate value filters and doesn't time out on
 * dense town centres.
 */
function buildAreaQuery(lat, lon, radiusM, tags) {
  const byKey = new Map();
  for (const t of tags) {
    if (!byKey.has(t.key)) byKey.set(t.key, new Set());
    byKey.get(t.key).add(t.value);
  }
  const clauses = [...byKey.entries()]
    .map(([key, values]) => {
      const re = `^(${[...values].join("|")})$`;
      return (
        `node["${key}"~"${re}"]["name"](around:${radiusM},${lat},${lon});` +
        `way["${key}"~"${re}"]["name"](around:${radiusM},${lat},${lon});`
      );
    })
    .join("\n");
  return `[out:json][timeout:50];\n(\n${clauses}\n);\nout center tags;`;
}

async function overpassOnce(endpoint, query) {
  const res = await fetch(endpoint, {
    method: "POST",
    signal: AbortSignal.timeout(45_000),
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(query)}`,
  });
  const text = await res.text();
  if (res.status === 429) throw Object.assign(new Error("rate limited"), { rateLimited: true });
  if (!text.startsWith("{")) throw new Error(`Overpass returned ${res.status}`);
  const data = JSON.parse(text);
  if (data.remark && /error|timeout/i.test(data.remark)) throw new Error(data.remark);
  return data;
}

/**
 * Overpass allows ~2 concurrent slots per IP; when busy it 429s or times out.
 * Try each endpoint, then wait and retry once — dense UK town centres often
 * succeed on the second attempt.
 */
async function runOverpass(query) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        return await overpassOnce(endpoint, query);
      } catch (err) {
        lastErr = err;
      }
    }
    if (attempt === 0) await sleep(20_000);
  }
  throw lastErr;
}

function categorise(tags) {
  for (const t of TAG_MAP) {
    if (tags[t.key] === t.value) return t.category;
  }
  return "other";
}

function extractAddress(tags) {
  const line1 = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ");
  return {
    line1: line1 || null,
    city: tags["addr:city"] || tags["addr:town"] || tags["addr:village"] || null,
    postcode: tags["addr:postcode"] || null,
  };
}

function normaliseWebsite(url) {
  if (!url) return null;
  let w = url.trim();
  if (!/^https?:\/\//i.test(w)) w = `https://${w}`;
  try {
    return new URL(w).toString();
  } catch {
    return null;
  }
}

function parseElement(el) {
  const tags = el.tags || {};
  const name = tags.name || tags.brand || tags.operator;
  if (!name) return null;
  return {
    osmId: `${el.type}/${el.id}`,
    name,
    category: categorise(tags),
    address: extractAddress(tags),
    phone: tags.phone || tags["contact:phone"] || null,
    email: tags.email || tags["contact:email"] || null,
    website: normaliseWebsite(tags.website || tags["contact:website"]),
    lat: el.lat ?? el.center?.lat ?? null,
    lon: el.lon ?? el.center?.lon ?? null,
    openingHours: tags.opening_hours || null,
    isChain: Boolean(tags.brand || tags["brand:wikidata"]),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Discover businesses around a place.
 * Returns every match in the search area (sorted nearest-first) so the pipeline
 * can walk the list until it has enough *new* leads or runs out of candidates.
 * @returns {Promise<{place: object, businesses: object[], categoryCounts: object}>}
 */
export async function discover({ place, radiusM = 2000, categories = [] }) {
  const geo = await geocode(place);
  const wanted = TAG_MAP.filter((t) => !categories?.length || categories.includes(t.category));

  const data = await runOverpass(buildAreaQuery(geo.lat, geo.lon, radiusM, wanted));

  const all = [];
  const seen = new Set();
  const categoryCounts = {};

  for (const el of data.elements || []) {
    const biz = parseElement(el);
    if (!biz) continue;
    const key = `${biz.name.toLowerCase()}|${biz.address.postcode || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    categoryCounts[biz.category] = (categoryCounts[biz.category] || 0) + 1;
    all.push(biz);
  }

  // Overpass returns elements in OSM-id order (oldest first), so recently added
  // businesses always land at the end and a naive `limit` cut would silently
  // drop them. Sort nearest-first so the limit keeps what's closest to the
  // searched place — searching a business's own postcode now always includes it.
  const latRad = (geo.lat * Math.PI) / 180;
  for (const biz of all) {
    biz.distanceM =
      biz.lat == null || biz.lon == null
        ? Infinity
        : Math.round(Math.hypot(biz.lat - geo.lat, (biz.lon - geo.lon) * Math.cos(latRad)) * 111_320);
  }
  all.sort((a, b) => a.distanceM - b.distanceM);

  return { place: geo, businesses: all, categoryCounts };
}
