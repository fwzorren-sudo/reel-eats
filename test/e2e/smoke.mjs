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
const list = (s) => JSON.parse(s || "[]");
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

assert.equal(p.instagram_handle, "tacosdelnorte");
assert.equal(p.go_soon, "New opening", "from the transcript");
assert.equal(p.time_zone, "America/New_York");
assert.equal(JSON.parse(p.hours).periods.length, 7);
assert.equal(p.posted_at, 1790000000000);
assert.ok(p.photo_key, "cover image saved");
let img = await fetch(`${BASE}/api/media/${p.photo_key}`);
assert.equal(img.status, 200, "images load without the access code, for <img> tags");
assert.equal(img.headers.get("content-type"), "image/png");
r = await call("/api/state");
let share1 = r.data.sources.filter((s) => s.place_id === p.id);
assert.equal(share1.length, 1);
assert.equal(share1[0].source_author, "nycfoodie");
step("keeps the handle, hours, post date, cover image and a 'go soon' note from the transcript");

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

r = await share({ url: IG("TACOS2") });
assert.equal(r.data.status, "done", JSON.stringify(r.data));
assert.equal(r.data.places.length, 0);
assert.equal(r.data.duplicates[0].google_place_id, "tdn");
assert.match(r.data.message, /Already on your list: Tacos Del Norte\. Added this reel to it\. 2 creators have recommended it now\./);
r = await call("/api/state");
const tdn = byGoogle(r.data.places, "tdn");
assert.deepEqual(r.data.sources.filter((s) => s.place_id === tdn.id).map((s) => s.source_author), ["nycfoodie", "queenseats"]);
assert.ok(list(tdn.tags).includes("date night"), tdn.tags);
step("adds a second creator's reel to a place already saved");

r = await share({ url: IG(`MYSTERY${Date.now()}`) });
assert.equal(r.data.status, "failed", JSON.stringify(r.data));
const mysteryId = r.data.share_id;
r = await call("/api/state");
assert.equal(r.data.shares.find((s) => s.id === mysteryId).status, "failed");
r = await call(`/api/shares/${mysteryId}/retry`, { method: "POST", body: { note: "Lucali, Carroll Gardens" } });
assert.equal(r.data.status, "done", JSON.stringify(r.data));
assert.equal(r.data.places[0].google_place_id, "lucali");
step("asks for a name when the post is unclear, then saves it on retry");

r = await share({ url: IG("FALLBACK") });
assert.equal(r.data.status, "done", JSON.stringify(r.data));
assert.equal(r.data.duplicates[0].google_place_id, "lucali");
assert.equal(r.data.share.source_author, "lucalifan");
step("falls back to Apify's official scraper when Post Details fails");

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

r = await share({ url: IG("DdmxY_iRYKE") });
assert.equal(r.data.status, "done", JSON.stringify(r.data));
p = r.data.places[0];
assert.equal(p.name, "Rosetta Bakery");
assert.equal(p.category, "Bakery & Desserts");
assert.equal(p.branch_count, 2);
assert.equal(p.source_author, "atlfoodiesofficial");
assert.equal(p.instagram_handle, "rosettabakery");
assert.deepEqual(list(p.tags), ["coffee date", "work-friendly", "outdoor seating"]);
assert.equal(p.go_soon, "New opening");
assert.equal(new Date(p.posted_at).toISOString(), "2026-09-22T22:08:57.000Z");
assert.equal(r.data.share.transcript.slice(0, 40), "Atlanta just got a new Italian bakery an");
assert.equal(JSON.parse(r.data.share.raw_post).code, "DdmxY_iRYKE");
assert.equal(JSON.parse(r.data.share.source_location).name, "Atlanta, Georgia");
step("saves the Rosetta Bakery reel from real Apify results, with its transcript and tags");

const rosettaShare = r.data.share_id;
r = await call(`/api/shares/${rosettaShare}/reread`, { method: "POST" });
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal(r.data.via, "apify");
assert.equal(r.data.transcript, true);
assert.equal(r.data.places.length, 1);
assert.deepEqual(list(r.data.places[0].tags), ["coffee date", "work-friendly", "outdoor seating"], "re-reading doesn't duplicate tags");
step("re-reads a saved reel to fill in details collected since");

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
assert.equal(places.length, MODE === "claude" ? 10 : 9, places.map((x) => x.name).join(", "));
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

r = await call(`/api/places/${lucali.id}`, { method: "PATCH", body: { tags: ["date night", "not a tag"], go_soon: "" } });
assert.deepEqual(list(r.data.place.tags), ["date night"]);
assert.equal(r.data.place.go_soon, null);
step("edits tags by hand");

/* ----- a partner's access code ----- */
r = await call("/api/members", { method: "POST", body: { name: "Sam" } });
assert.equal(r.status, 200, JSON.stringify(r.data));
const samCode = r.data.code;
const samId = r.data.member.id;
assert.match(samCode, /^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
r = await call("/api/state", { token: samCode });
assert.deepEqual(r.data.viewer, { role: "member", name: "Sam" });
r = await call("/api/share?wait=1", { method: "POST", body: { note: "Katz's Delicatessen" }, token: samCode });
assert.equal(r.data.status, "done", JSON.stringify(r.data));
assert.equal(r.data.places[0].added_by, "Sam");
r = await call("/api/members", { token: samCode });
assert.equal(r.status, 403);
r = await call("/api/members");
assert.deepEqual(r.data.members.map((x) => x.name), ["Sam"]);
assert.equal(r.data.members[0].code_hash, undefined, "the code's hash stays on the server");
await call(`/api/members/${samId}`, { method: "DELETE" });
r = await call("/api/state", { token: samCode });
assert.equal(r.status, 401);
step("gives a partner their own code, marks their saves, and turns the code off");

/* ----- a read-only link ----- */
r = await call("/api/links", { method: "POST", body: { label: "Pizza for Alex", status: "all", category: "Pizza" } });
const token = r.data.link.token;
let pub = await fetch(`${BASE}/api/public/${token}`).then((x) => x.json());
assert.equal(pub.label, "Pizza for Alex");
assert.deepEqual(pub.places.map((x) => x.name).sort(), [MODE === "claude" ? "Joe's Pizza" : "Joe's Pizza Broadway", "L'industrie Pizzeria", "Lucali"]);
const pubLucali = pub.places.find((x) => x.name === "Lucali");
for (const key of ["notes", "distance_m", "branches", "added_by"]) assert.equal(pubLucali[key], undefined, `${key} stays private`);
assert.equal(pubLucali.visit_status, "visited");
assert.ok(pub.sources.length >= 2);
assert.equal(pub.home, undefined);
await call(`/api/links/${token}`, { method: "DELETE" });
assert.equal((await fetch(`${BASE}/api/public/${token}`)).status, 404);
step("shares a read-only list without notes, home or distances, and turns the link off");

/* ----- upkeep ----- */
r = await call("/api/maintenance/refresh", { method: "POST", body: { all: true } });
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.ok(r.data.checked >= 5, `checked ${r.data.checked}`);
assert.deepEqual(r.data.closed, ["Absolute Bagels"]);
assert.equal(r.data.apify.used, 4.2);
r = await call("/api/state");
assert.equal(byGoogle(r.data.places, "abs").business_status, "CLOSED_PERMANENTLY");
assert.equal(r.data.apify.limit, 5);
assert.ok(byGoogle(r.data.places, "tdn").refreshed_at > Date.now() - 60000);
step("re-checks places with Google, spots a permanent closure, and checks Apify credit");

console.log(`\nAll end-to-end checks passed (${MODE}).`);
