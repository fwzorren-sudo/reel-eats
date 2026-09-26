// End-to-end API check against `wrangler dev` wired to mock-upstreams.mjs. See README "Testing".
// Usage: MODE=rules|claude node test/e2e/smoke.mjs [baseUrl] [accessCode] [mockBase]
//   rules:  Worker started without ANTHROPIC_API_KEY (and AI_MODEL=off), so venues come from rules.
//   claude: Worker started with ANTHROPIC_API_KEY pointing at the mock.
import assert from "node:assert/strict";

const MODE = process.env.MODE || "rules";
const BASE = process.argv[2] || "http://127.0.0.1:8787";
const CODE = process.argv[3] || "test-code";
const MOCK = process.argv[4] || "http://127.0.0.1:8799";
const IG = (code) => `https://www.instagram.com/reel/${code}/`;

async function call(path, { method = "GET", body, token = CODE } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}
const byGoogle = (places, id) => places.find((p) => p.google_place_id === id);
const step = (name) => console.log(`✓ ${name}`);
const share = (body) => call("/api/share?wait=1", { method: "POST", body });

console.log(`Mode: ${MODE}\n`);

let r = await call("/api/state", { token: "wrong" });
assert.equal(r.status, 401);
r = await call("/api/state");
assert.equal(r.data.features.engine, MODE);
assert.equal(r.data.features.apify, true);
step("checks the access code and reports how reels are read");

r = await share({ url: `${IG("TACOS1")}?igsh=abc` });
assert.equal(r.data.status, "done", JSON.stringify(r.data));
let p = r.data.places[0];
assert.equal(p.google_place_id, "tdn");
assert.equal(p.name, "Tacos Del Norte");
assert.equal(p.category, "Tacos & Mexican");
assert.equal(p.distance_m, null);
assert.match(r.data.message, /Saved Tacos Del Norte in Queens/);
step(MODE === "rules" ? "turns an @mention in the caption into the restaurant" : "saves a reel Claude identified");

r = await call("/api/home", { method: "PUT", body: { address: "350 5th Ave, New York" } });
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal(r.data.home.address, "350 5th Ave, New York, NY 10118, USA");
r = await call("/api/state");
assert.ok(byGoogle(r.data.places, "tdn").distance_m > 7000);
step("sets home and back-fills distances");

r = await share({ text: `lol ${IG("SHACK1")}?igsh=x` });
assert.equal(r.data.status, "done", JSON.stringify(r.data));
p = r.data.places[0];
assert.equal(p.google_place_id, "ss_hs");
assert.equal(p.name, "Shake Shack");
assert.equal(p.branch_count, 3);
assert.equal(p.category, "Burgers");
assert.ok(p.distance_m < 500, `distance ${p.distance_m}`);
assert.match(r.data.message, /Shake Shack, 0\.\d mi from home/);
step("picks the chain branch closest to home, not the one in the location tag");

r = await share({ url: IG("PIZZA1") });
assert.equal(r.data.status, "done", JSON.stringify(r.data));
assert.ok(byGoogle(r.data.places, "joes"));
assert.ok(byGoogle(r.data.places, "lind"));
if (MODE === "claude") {
  assert.equal(r.data.places.length, 3);
  assert.equal(r.data.places.find((x) => !x.located).name, "Secret Supper Club");
} else {
  assert.equal(r.data.places.length, 2, "an unfindable pin is dropped when others were found");
}
step("saves each pinned venue from a list reel");

r = await share({ url: IG("TACOS1") });
assert.equal(r.data.status, "duplicate");
assert.match(r.data.message, /Already on your list: Tacos Del Norte/);
step("recognises the same reel shared twice");

r = await share({ url: IG(`MYSTERY${Date.now()}`) });
assert.equal(r.data.status, "failed", JSON.stringify(r.data));
const mysteryId = r.data.share_id;
r = await call("/api/state");
assert.equal(r.data.shares.find((s) => s.id === mysteryId).status, "failed");
r = await call(`/api/shares/${mysteryId}/retry`, { method: "POST", body: { note: "Lucali, Carroll Gardens" } });
assert.equal(r.data.status, "done", JSON.stringify(r.data));
assert.equal(r.data.places[0].google_place_id, "lucali");
step("asks for a name when the post is unclear, then saves it on retry");

r = await share({ text: "Best bagels in the city\n📍 Absolute Bagels, UWS" });
assert.equal(r.data.status, "done", JSON.stringify(r.data));
assert.equal(r.data.places[0].google_place_id, "abs");
assert.equal(r.data.places[0].category, "Bakery & Desserts");
step("reads text shared without a link, as the screenshot shortcut sends it");

r = await share({ url: `${MOCK}/blog/ramen` });
assert.equal(r.data.status, "done", JSON.stringify(r.data));
assert.equal(r.data.places[0].google_place_id, "tsujita");
assert.equal(r.data.places[0].category, "Ramen & Noodles");
step("works with links from other sites");

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
r = await call("/api/share", { method: "POST", body: { image_base64: png, image_type: "image/png" } });
if (MODE === "claude") {
  assert.equal(r.status, 202);
  const id = r.data.share_id;
  let done = false;
  for (let i = 0; i < 20 && !done; i++) {
    await new Promise((res) => setTimeout(res, 500));
    done = !(await call("/api/state")).data.shares.some((s) => s.id === id);
  }
  assert.ok(done, "background processing finished");
  step("reads a screenshot in the background after replying immediately");
} else {
  assert.equal(r.status, 422);
  assert.match(r.data.message, /Claude option/);
  step("explains that uploaded screenshots need the Claude option");
}

const form = new FormData();
form.set("url", IG("SHACK1"));
const t = await fetch(`${BASE}/api/share?format=text&wait=1`, { method: "POST", headers: { Authorization: `Bearer ${CODE}` }, body: form });
assert.equal(t.headers.get("content-type"), "text/plain; charset=utf-8");
assert.match(await t.text(), /Already on your list: Shake Shack/);
step("answers the iPhone shortcut in plain text from a form post");

r = await call("/api/share", { method: "POST", body: { image_base64: "AAAAGGZ0eXBoZWljAAAAAG1pZjE=", image_type: "image/heic" } });
assert.equal(r.status, 415);
r = await call("/api/share", { method: "POST", body: {} });
assert.equal(r.status, 400);
step("rejects HEIC images and empty shares with clear messages");

r = await share({ note: "Grandma's Kitchen Pop-up" });
assert.equal(r.data.status, "done", JSON.stringify(r.data));
const popup = r.data.places[0];
assert.equal(popup.located, 0);
step("keeps a typed name even when Google can't find it");

r = await call("/api/state");
let places = r.data.places;
assert.equal(places.length, MODE === "claude" ? 9 : 8, places.map((x) => x.name).join(", "));
const lucali = byGoogle(places, "lucali");
r = await call(`/api/places/${lucali.id}`, { method: "PATCH", body: { visit_status: "visited", my_rating: 5, notes: "Bring cash" } });
assert.equal(r.data.place.visit_status, "visited");
assert.ok(r.data.place.visited_at > 0);
r = await call(`/api/places/${lucali.id}`, { method: "PATCH", body: { my_rating: 9 } });
assert.equal(r.status, 400);
step("marks visited with a rating and notes, and validates input");

const shack = byGoogle(places, "ss_hs");
r = await call(`/api/places/${shack.id}`, { method: "PATCH", body: { branch_id: "ss_msp" } });
assert.equal(r.data.place.google_place_id, "ss_msp");
r = await call(`/api/places/${shack.id}/recheck`, { method: "POST" });
assert.equal(r.data.found, true);
assert.equal(r.data.place.google_place_id, "ss_hs");
step("switches branches by hand and re-checks back to the nearest");

r = await call(`/api/search?q=${encodeURIComponent("Lucali Brooklyn, NY")}`);
assert.equal(r.data.results[0].id, "lucali");
assert.ok(r.data.results[0].distanceM > 1000);
r = await call(`/api/places/${popup.id}/select`, { method: "POST", body: { place_id: "gk" } });
assert.equal(r.data.place.located, 1);
assert.equal(r.data.place.name, "Grandma's Kitchen");
step("searches Google Maps and attaches a location to an unlocated place");

await call("/api/home", { method: "PUT", body: { address: "Lucali Brooklyn, NY" } });
places = (await call("/api/state")).data.places;
assert.ok(byGoogle(places, "lucali").distance_m < 50);
assert.ok(byGoogle(places, "ss_msp"), "Shake Shack moved to the branch nearest the new home");
step("moving home switches chains to the branch closest to the new address");
await call("/api/home", { method: "PUT", body: { address: "350 5th Ave, New York" } });
await call(`/api/places/${shack.id}/recheck`, { method: "POST" });

r = await call(`/api/places/${popup.id}`, { method: "DELETE" });
assert.equal(r.status, 200);
assert.equal((await call("/api/state")).data.places.length, places.length - 1);
step("deletes a place");

console.log(`\nAll end-to-end checks passed (${MODE}).`);
