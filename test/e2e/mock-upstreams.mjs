// Stand-ins for the Anthropic API, Google Places, Apify and a reel page, for local end-to-end runs.
// Usage: node test/e2e/mock-upstreams.mjs [port]
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import zlib from "node:zlib";

const port = Number(process.argv[2] || 8799);

const P = (id, name, lat, lng, extra = {}) => ({
  id,
  displayName: { text: name },
  formattedAddress: extra.address || `${name}, New York, NY`,
  location: { latitude: lat, longitude: lng },
  googleMapsUri: `https://maps.google.com/?cid=${id}`,
  websiteUri: extra.website,
  nationalPhoneNumber: "(212) 555-0100",
  rating: extra.rating ?? 4.5,
  userRatingCount: extra.count ?? 1200,
  priceLevel: extra.price || "PRICE_LEVEL_MODERATE",
  businessStatus: "OPERATIONAL",
  primaryType: extra.type || "restaurant",
  primaryTypeDisplayName: { text: extra.typeLabel || "Restaurant" },
  types: [extra.type || "restaurant", ...(extra.type === "street_address" ? [] : ["restaurant", "food"])],
  addressComponents: [
    { longText: extra.city || "New York", shortText: extra.city || "New York", types: ["locality"] },
    { longText: "New York", shortText: "NY", types: ["administrative_area_level_1"] },
  ],
  ...(extra.hours ? { regularOpeningHours: extra.hours, timeZone: { id: extra.tz || "America/New_York" }, utcOffsetMinutes: -240 } : {}),
  ...(extra.status ? { businessStatus: extra.status } : {}),
});

// Open 11am to 10pm every day.
const DAILY = {
  openNow: true,
  periods: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ open: { day, hour: 11, minute: 0 }, close: { day, hour: 22, minute: 0 } })),
  weekdayDescriptions: ["Monday: 11:00 AM – 10:00 PM", "Tuesday: 11:00 AM – 10:00 PM", "Wednesday: 11:00 AM – 10:00 PM", "Thursday: 11:00 AM – 10:00 PM", "Friday: 11:00 AM – 10:00 PM", "Saturday: 11:00 AM – 10:00 PM", "Sunday: 11:00 AM – 10:00 PM"],
};

const PLACES = {
  home: P("home", "350 5th Ave", 40.7484, -73.9857, { address: "350 5th Ave, New York, NY 10118, USA", type: "street_address", typeLabel: "Address" }),
  tdn: P("tdn", "Tacos Del Norte", 40.7466, -73.8913, { address: "84-12 Roosevelt Ave, Queens, NY 11372", city: "Queens", price: "PRICE_LEVEL_INEXPENSIVE", type: "mexican_restaurant", typeLabel: "Mexican Restaurant", hours: DAILY }),
  ss_msp: P("ss_msp", "Shake Shack Madison Square Park", 40.7414, -73.9882, { website: "https://shakeshack.com/location/madison-square-park", address: "Madison Ave & E 23rd St, New York, NY 10010", type: "hamburger_restaurant", typeLabel: "Hamburger Restaurant" }),
  ss_hs: P("ss_hs", "Shake Shack Herald Square", 40.7503, -73.988, { website: "https://shakeshack.com/location/herald-square", address: "1333 Broadway, New York, NY 10018", type: "hamburger_restaurant", typeLabel: "Hamburger Restaurant" }),
  ss_gc: P("ss_gc", "Shake Shack Grand Central", 40.7527, -73.9772, { website: "https://shakeshack.com/location/grand-central", address: "87 E 42nd St, New York, NY 10017", type: "hamburger_restaurant", typeLabel: "Hamburger Restaurant" }),
  joes: P("joes", "Joe's Pizza Broadway", 40.7547, -73.987, { address: "1435 Broadway, New York, NY 10018", price: "PRICE_LEVEL_INEXPENSIVE", rating: 4.6, count: 21000, type: "pizza_restaurant", typeLabel: "Pizza Restaurant" }),
  lind: P("lind", "L'industrie Pizzeria", 40.7115, -73.958, { address: "254 S 2nd St, Brooklyn, NY 11211", city: "Brooklyn", rating: 4.7, type: "pizza_restaurant", typeLabel: "Pizza Restaurant" }),
  lucali: P("lucali", "Lucali", 40.6806, -74.0005, { address: "575 Henry St, Brooklyn, NY 11231", city: "Brooklyn", rating: 4.6, price: "PRICE_LEVEL_EXPENSIVE", type: "pizza_restaurant", typeLabel: "Pizza Restaurant" }),
  abs: P("abs", "Absolute Bagels", 40.8024, -73.9674, { address: "2788 Broadway, New York, NY 10025", type: "bagel_shop", typeLabel: "Bagel Shop", price: "PRICE_LEVEL_INEXPENSIVE" }),
  tsujita: P("tsujita", "Tsujita LA Artisan Noodle", 34.0395, -118.4428, { address: "2057 Sawtelle Blvd, Los Angeles, CA 90025", city: "Los Angeles", type: "ramen_restaurant", typeLabel: "Ramen Restaurant" }),
  // Rosetta Bakery branch coordinates are made up; the reel caption is a real Apify result.
  rb_high: P("rb_high", "Rosetta Bakery", 33.9296, -84.344, { address: "120 High St, Dunwoody, GA 30346", city: "Dunwoody", website: "https://www.rosettabakery.com/", type: "bakery", typeLabel: "Bakery" }),
  rb_west: P("rb_west", "Rosetta Bakery", 33.787, -84.412, { address: "1100 Howell Mill Rd, Atlanta, GA 30318", city: "Atlanta", website: "https://www.rosettabakery.com/", type: "bakery", typeLabel: "Bakery" }),
  gk: P("gk", "Grandma's Kitchen", 40.7306, -73.9866, { address: "10 E 14th St, New York, NY 10003", type: "american_restaurant", typeLabel: "American Restaurant" }),
  katz: P("katz", "Katz's Delicatessen", 40.7223, -73.9874, { address: "205 E Houston St, New York, NY 10002", type: "sandwich_shop", typeLabel: "Deli", hours: DAILY }),
};

// Google's details for these say the place has since closed for good.
const CLOSED_SINCE = new Set(["abs"]);

const SEARCH = {
  "350 5th Ave, New York": ["home"],
  "Tacos Del Norte": ["tdn"],
  "Tacos Del Norte Queens, NY": ["tdn"],
  "Shake Shack": ["ss_msp", "ss_hs", "ss_gc"],
  "Shake Shack New York, NY": ["ss_msp"],
  "Joe's Pizza": ["joes"],
  "Joe's Pizza New York, NY": ["joes"],
  "L'industrie Pizzeria": ["lind"],
  "L'industrie Pizzeria Brooklyn, NY": ["lind"],
  "Lucali": ["lucali"],
  "Lucali Brooklyn, NY": ["lucali"],
  "Lucali Carroll Gardens": ["lucali"],
  // Names the rules find in captions, tags and handles
  "tacosdelnorte": ["tdn"],
  "Shake Shack Madison Square Park": ["ss_msp"],
  "Joe's Pizza Broadway": ["joes"],
  "L'industrie": ["lind"],
  "L'industrie Williamsburg": ["lind"],
  "Absolute Bagels": ["abs"],
  "Absolute Bagels UWS": ["abs"],
  "Tsujita LA": ["tsujita"],
  "Tsujita LA Los Angeles, CA": ["tsujita"],
  "Rosetta Bakery": ["rb_west", "rb_high"],
  "Rosetta Bakery 120 High Street, Dunwoody, GA": ["rb_high"],
  "Rosetta Bakery Dunwoody, GA": ["rb_high"],
  "Katz's Delicatessen": ["katz"],
};

// Real results from Apify, used as-is.
const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"))[0];
const ROSETTA = fixture("apify-rosetta.json");
const ROSETTA_POST = fixture("apify-post-details-rosetta.json");
const ROSETTA_TRANSCRIPT = fixture("apify-transcript-rosetta.json");

/** A small gradient PNG, a different color per reel, served as each reel's cover image. */
function coverImage(seed) {
  const w = 90, h = 120;
  const hue = [...seed].reduce((n, c) => n + c.charCodeAt(0), 0) % 360;
  const rgb = (l) => {
    const c = (1 - Math.abs(2 * l - 1)) * 0.7, x = c * (1 - Math.abs(((hue / 60) % 2) - 1)), m = l - c / 2;
    const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
    return [r + m, g + m, b + m].map((v) => Math.round(v * 255));
  };
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    const [r, g, b] = rgb(0.35 + (0.35 * y) / h);
    for (let x = 0; x < w; x++) row.set([r, g, b], 1 + x * 3);
    rows.push(row);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// What Apify's Instagram Scraper returns for each test reel, by shortcode.
const REELS = {
  TACOS1: { ownerUsername: "nycfoodie", ownerFullName: "NYC Foodie", caption: "The best birria tacos in Queens 🌮 @tacosdelnorte get the consomé", locationName: "" },
  SHACK1: { ownerUsername: "burgerhunter", caption: "Shake Shack still hits after a long day. ShackBurger + fries", locationName: "Shake Shack Madison Square Park" },
  PIZZA1: {
    ownerUsername: "sliceguide",
    caption: "My top 3 pizza spots in NYC right now\n1. Joe's Pizza 📍 Broadway\n2. L'industrie 📍 Williamsburg\n3. Secret Supper Club 📍 ask me for the address",
    locationName: "",
  },
  MYSTERY: { ownerUsername: "randomeats", caption: "Unreal dinner last night 🤤", locationName: "" },
  // A second creator recommending a place that's already saved.
  TACOS2: { ownerUsername: "queenseats", caption: "Date night at @tacosdelnorte, the birria is unreal", locationName: "" },
  // Post Details fails for this one, so the official scraper is used.
  FALLBACK: { ownerUsername: "lucalifan", caption: "📍 Lucali, Carroll Gardens. Worth the wait.", locationName: "" },
};

// What's said in each test reel.
const TRANSCRIPTS = {
  TACOS1: "This taqueria in Queens just opened and the birria tacos are unreal.",
  DdmxY_iRYKE: ROSETTA_TRANSCRIPT,
};

const codeOf = (u) => (u || "").match(/\/(?:reel|p)\/([A-Za-z0-9_-]+)/)?.[1] || "";
const reelFor = (code) => REELS[code.replace(/\d+$/, "") === "MYSTERY" ? "MYSTERY" : code];
const image = (code) => `http://127.0.0.1:${port}/img/${code}.png`;

/** Apify Post Details returns Instagram's own media object. */
function postDetails(code) {
  if (code === "DdmxY_iRYKE") return { ...ROSETTA_POST, thumbnail_url: image(code) };
  const r = reelFor(code);
  if (!r || code === "FALLBACK") return null;
  return {
    code,
    taken_at: 1790000000,
    caption: { text: r.caption, mentions: [] },
    user: { username: r.ownerUsername, full_name: r.ownerFullName || "" },
    location: r.locationName ? { name: r.locationName, lat: 40.7414, lng: -73.9882, address: "Madison Ave & E 23rd St", city: "New York" } : null,
    tagged_users: [],
    coauthor_producers: [],
    thumbnail_url: image(code),
  };
}

const venue = (name, category, city, extra = {}) => ({
  name,
  alt_names: [],
  search_query: name,
  city,
  address_hint: "",
  instagram_handle: "",
  category,
  cuisine: extra.cuisine || "",
  summary: extra.summary || "",
  dishes: extra.dishes || [],
  multi_location: !!extra.multi,
  confidence: "high",
});

function decide(text, hasImage) {
  const t = text.toLowerCase();
  if (hasImage || t.includes("lucali")) return { places: [venue("Lucali", "Pizza", "Brooklyn, NY", { cuisine: "Thin-crust pizza", summary: "Candlelit pies and calzones worth the wait.", dishes: ["Plain pie", "Calzone"] })], reason: "" };
  if (t.includes("rosetta bakery")) return { places: [venue("Rosetta Bakery", "Bakery & Desserts", "Dunwoody, GA", { cuisine: "Italian bakery", multi: true })], reason: "" };
  if (t.includes("absolute bagels")) return { places: [venue("Absolute Bagels", "Bakery & Desserts", "New York, NY", { cuisine: "Bagels" })], reason: "" };
  if (t.includes("tsujita")) return { places: [venue("Tsujita LA", "Ramen & Noodles", "Los Angeles, CA", { cuisine: "Tsukemen" })], reason: "" };
  if (t.includes("katz")) return { places: [venue("Katz's Delicatessen", "Sandwiches & Deli", "New York, NY", { cuisine: "Pastrami" })], reason: "" };
  if (t.includes("grandma")) return { places: [venue("Grandma's Kitchen Pop-up", "Other", "", {})], reason: "" };
  if (t.includes("mystery")) return { places: [], reason: "The caption only shows a plate of food with no venue name, tag or location." };
  if (t.includes("tacosdelnorte") || t.includes("tacos del norte")) {
    return { places: [venue("Tacos Del Norte", "Tacos & Mexican", "Queens, NY", { cuisine: "Birria tacos", summary: "Rich birria tacos with consomé for dipping.", dishes: ["Birria tacos", "Consomé", "Quesabirria"] })], reason: "" };
  }
  if (t.includes("shake shack")) {
    return { places: [venue("Shake Shack", "Burgers", "New York, NY", { cuisine: "Smash burgers", summary: "The ShackBurger and a black-and-white shake.", dishes: ["ShackBurger", "Crinkle fries"], multi: true })], reason: "" };
  }
  if (t.includes("top 3")) {
    return {
      places: [
        venue("Joe's Pizza", "Pizza", "New York, NY", { cuisine: "NY slice", summary: "Classic foldable cheese slice.", dishes: ["Cheese slice"] }),
        venue("L'industrie Pizzeria", "Pizza", "Brooklyn, NY", { cuisine: "Burrata slice", summary: "Burrata slice with a line out the door.", dishes: ["Burrata slice"] }),
        venue("Secret Supper Club", "Other", "", { cuisine: "Pop-up dinner", summary: "Monthly pop-up with no fixed address." }),
      ],
      reason: "",
    };
  }
  return { places: [], reason: "No venue in this post." };
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const url = new URL(req.url, `http://127.0.0.1:${port}`);

  if (req.method === "POST" && url.pathname === "/v1/messages") {
    const body = JSON.parse(raw);
    const content = body.messages[0].content;
    const text = content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const hasImage = content.some((b) => b.type === "image");
    console.log(`[claude] model=${body.model} fallbacks=${JSON.stringify(body.fallbacks)} beta=${req.headers["anthropic-beta"]} tools=${body.tools.map((t) => t.type || t.name).join(",")}`);
    return send(res, 200, {
      id: "msg_mock",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "tool_use", id: "toolu_mock", name: "save_places", input: decide(text, hasImage) }],
      stop_reason: "tool_use",
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 500, output_tokens: 120 },
    });
  }

  const actor = url.pathname.match(/^\/v2\/acts\/([\w~.-]+)\/run-sync-get-dataset-items$/)?.[1];
  if (req.method === "POST" && actor) {
    if (req.headers.authorization !== "Bearer test-apify") return send(res, 401, { error: { type: "token-not-valid" } });
    const body = JSON.parse(raw);
    const link = body.postUrls?.[0] || body.bulkUrls?.[0] || body.directUrls?.[0] || "";
    const code = codeOf(link);
    let out = [];
    if (actor === "data-slayer~instagram-post-details") {
      if (code === "FALLBACK") return send(res, 500, { error: { message: "mock: post details failed" } });
      const item = postDetails(code);
      out = item ? [item] : [];
    } else if (actor === "apple_yang~instagram-transcripts-scraper") {
      const t = TRANSCRIPTS[code];
      out = !t ? [] : typeof t === "string" ? [{ url: link, code, text: t, title: reelFor(code)?.caption || "" }] : [t];
    } else if (actor === "apify~instagram-scraper") {
      const reel = code === "DdmxY_iRYKE" ? ROSETTA : reelFor(code);
      out = reel ? [{ url: link, shortCode: code, displayUrl: image(code), ...reel }] : [];
    }
    console.log(`[apify] ${actor} ${link} -> ${out.length ? code : "none"}`);
    return send(res, 200, out);
  }

  if (req.method === "GET" && url.pathname === "/v2/users/me/limits") {
    if (req.headers.authorization !== "Bearer test-apify") return send(res, 401, { error: { type: "token-not-valid" } });
    return send(res, 200, {
      data: { monthlyUsageCycle: { endAt: "2026-10-22T23:59:59.999Z" }, limits: { maxMonthlyUsageUsd: 5 }, current: { monthlyUsageUsd: 4.2 } },
    });
  }

  if (req.method === "GET" && url.pathname.startsWith("/img/")) {
    const png = coverImage(url.pathname);
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length });
    return res.end(png);
  }

  if (req.method === "GET" && url.pathname === "/blog/ramen") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(
      '<html><head><meta property="og:title" content="Best ramen in LA"><meta property="og:description" content="📍 Tsujita LA, Sawtelle — the tsukemen is unreal"></head></html>',
    );
  }

  if (req.method === "POST" && url.pathname === "/v1/places:searchText") {
    if (req.headers["x-goog-api-key"] !== "test-google-key") return send(res, 403, { error: { message: "API key not valid." } });
    const body = JSON.parse(raw);
    const ids = SEARCH[body.textQuery] || [];
    console.log(`[places] "${body.textQuery}" bias=${!!body.locationBias} -> ${ids.join(",") || "none"}`);
    return send(res, 200, { places: ids.map((id) => PLACES[id]) });
  }

  const detail = url.pathname.match(/^\/v1\/places\/([\w-]+)$/);
  if (req.method === "GET" && detail) {
    const p = PLACES[detail[1]];
    if (!p) return send(res, 404, { error: { message: "Not found" } });
    return send(res, 200, CLOSED_SINCE.has(p.id) ? { ...p, businessStatus: "CLOSED_PERMANENTLY" } : p);
  }

  if (req.method === "GET" && url.pathname.startsWith("/reel/")) {
    const slug = url.pathname.split("/")[2];
    const captions = {
      tacos: ["nycfoodie", "The best birria tacos in Queens 🌮 @tacosdelnorte get the consomé"],
      shack: ["burgerhunter", "Shake Shack still hits after a long day ShackBurger + fries"],
      pizza: ["sliceguide", "My top 3 pizza spots in NYC right now"],
      mystery: ["randomeats", "Unreal dinner last night 🤤"],
    };
    const [author, caption] = captions[slug] || ["someone", "nice food"];
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(
      `<html><head><meta property="og:title" content="${author} on Instagram: &quot;${caption}&quot;"><meta property="og:image" content="https://example.com/${slug}.jpg"></head><body></body></html>`,
    );
  }

  send(res, 404, { error: { message: `mock: no route for ${req.method} ${url.pathname}` } });
});

server.listen(port, "127.0.0.1", () => console.log(`mock upstreams on http://127.0.0.1:${port}`));
