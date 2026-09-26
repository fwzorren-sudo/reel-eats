// Stand-ins for the Anthropic API, Google Places and a reel page, for local end-to-end runs.
// Usage: node test/e2e/mock-upstreams.mjs [port]
import { createServer } from "node:http";

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
  addressComponents: [
    { longText: extra.city || "New York", shortText: extra.city || "New York", types: ["locality"] },
    { longText: "New York", shortText: "NY", types: ["administrative_area_level_1"] },
  ],
});

const PLACES = {
  home: P("home", "350 5th Ave", 40.7484, -73.9857, { address: "350 5th Ave, New York, NY 10118, USA" }),
  tdn: P("tdn", "Tacos Del Norte", 40.7466, -73.8913, { address: "84-12 Roosevelt Ave, Queens, NY 11372", city: "Queens", price: "PRICE_LEVEL_INEXPENSIVE" }),
  ss_msp: P("ss_msp", "Shake Shack Madison Square Park", 40.7414, -73.9882, { website: "https://shakeshack.com/location/madison-square-park", address: "Madison Ave & E 23rd St, New York, NY 10010" }),
  ss_hs: P("ss_hs", "Shake Shack Herald Square", 40.7503, -73.988, { website: "https://shakeshack.com/location/herald-square", address: "1333 Broadway, New York, NY 10018" }),
  ss_gc: P("ss_gc", "Shake Shack Grand Central", 40.7527, -73.9772, { website: "https://shakeshack.com/location/grand-central", address: "87 E 42nd St, New York, NY 10017" }),
  joes: P("joes", "Joe's Pizza Broadway", 40.7547, -73.987, { address: "1435 Broadway, New York, NY 10018", price: "PRICE_LEVEL_INEXPENSIVE", rating: 4.6, count: 21000 }),
  lind: P("lind", "L'industrie Pizzeria", 40.7115, -73.958, { address: "254 S 2nd St, Brooklyn, NY 11211", city: "Brooklyn", rating: 4.7 }),
  lucali: P("lucali", "Lucali", 40.6806, -74.0005, { address: "575 Henry St, Brooklyn, NY 11231", city: "Brooklyn", rating: 4.6, price: "PRICE_LEVEL_EXPENSIVE" }),
};

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
};

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
    return p ? send(res, 200, p) : send(res, 404, { error: { message: "Not found" } });
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
