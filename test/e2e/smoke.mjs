// End-to-end API check against `wrangler dev` wired to mock-upstreams.mjs. See README "Testing".
// Usage: node test/e2e/smoke.mjs [baseUrl] [accessCode] [mockBase]
import assert from "node:assert/strict";

const BASE = process.argv[2] || "http://127.0.0.1:8787";
const CODE = process.argv[3] || "test-code";
const MOCK = process.argv[4] || "http://127.0.0.1:8799";

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
const byName = (places, name) => places.find((p) => p.name === name);
const step = (name) => console.log(`✓ ${name}`);

let r = await call("/api/state", { token: "wrong" });
assert.equal(r.status, 401);
step("rejects a wrong access code");

r = await call("/api/ping");
assert.equal(r.status, 200);
step("accepts the right access code");

r = await call("/api/share?wait=1", { method: "POST", body: { url: `${MOCK}/reel/tacos?igsh=abc` } });
assert.equal(r.data.status, "done", JSON.stringify(r.data));
assert.equal(r.data.places[0].name, "Tacos Del Norte");
assert.equal(r.data.places[0].distance_m, null);
assert.match(r.data.message, /Saved Tacos Del Norte in Queens/);
step("saves a reel before home is set, using the reel's city");

r = await call("/api/home", { method: "PUT", body: { address: "350 5th Ave, New York" } });
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal(r.data.home.address, "350 5th Ave, New York, NY 10118, USA");
r = await call("/api/state");
assert.ok(byName(r.data.places, "Tacos Del Norte").distance_m > 7000);
step("sets home and back-fills distances");

r = await call("/api/share?wait=1", { method: "POST", body: { text: `lol ${MOCK}/reel/shack` } });
assert.equal(r.data.status, "done", JSON.stringify(r.data));
const shack = r.data.places[0];
assert.equal(shack.google_place_id, "ss_hs");
assert.equal(shack.branch_count, 3);
assert.ok(shack.distance_m < 500, `distance ${shack.distance_m}`);
assert.match(r.data.message, /Shake Shack, 0\.\d mi from home/);
step("picks the chain branch closest to home (Herald Square, not the filmed one)");

r = await call("/api/share?wait=1", { method: "POST", body: { url: `${MOCK}/reel/pizza` } });
assert.equal(r.data.places.length, 3, JSON.stringify(r.data));
assert.equal(byName(r.data.places, "Secret Supper Club").located, 0);
assert.equal(byName(r.data.places, "Joe's Pizza").located, 1);
assert.match(r.data.message, /Saved 3 places/);
step("saves every venue from a multi-place reel and keeps unlocated ones");

r = await call("/api/share?wait=1", { method: "POST", body: { url: `${MOCK}/reel/tacos` } });
assert.equal(r.data.status, "duplicate");
assert.match(r.data.message, /Already on your list: Tacos Del Norte/);
step("recognises the same reel shared twice");

r = await call("/api/share?wait=1", { method: "POST", body: { url: `${MOCK}/reel/mystery` } });
assert.equal(r.data.status, "failed");
const mysteryId = r.data.share_id;
r = await call("/api/state");
assert.equal(r.data.shares.find((s) => s.id === mysteryId).status, "failed");
r = await call(`/api/shares/${mysteryId}/retry`, { method: "POST", body: { note: "Lucali, Carroll Gardens" } });
assert.equal(r.data.status, "done", JSON.stringify(r.data));
assert.equal(r.data.places[0].name, "Lucali");
step("asks for a name when the post is unclear, then saves it on retry");

// A 1x1 PNG stands in for a screenshot.
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
r = await call("/api/share", { method: "POST", body: { image_base64: png, image_type: "image/png" } });
assert.equal(r.status, 202);
assert.equal(r.data.status, "queued");
const imgShare = r.data.share_id;
let done = false;
for (let i = 0; i < 20 && !done; i++) {
  await new Promise((res) => setTimeout(res, 500));
  r = await call("/api/state");
  done = !r.data.shares.some((s) => s.id === imgShare);
}
assert.ok(done, "background processing finished");
step("processes a screenshot in the background after replying immediately");

const form = new FormData();
form.set("url", `${MOCK}/reel/shack`);
form.set("note", "the one near work");
const t = await fetch(`${BASE}/api/share?format=text&wait=1`, {
  method: "POST",
  headers: { Authorization: `Bearer ${CODE}` },
  body: form,
});
const tText = await t.text();
assert.equal(t.headers.get("content-type"), "text/plain; charset=utf-8");
assert.match(tText, /Already on your list: Shake Shack/);
step("answers the iPhone shortcut in plain text from a form post");

r = await call("/api/share", { method: "POST", body: { image_base64: "AAAAGGZ0eXBoZWljAAAAAG1pZjE=", image_type: "image/heic" } });
assert.equal(r.status, 415);
r = await call("/api/share", { method: "POST", body: {} });
assert.equal(r.status, 400);
step("rejects HEIC images and empty shares with clear messages");

r = await call("/api/state");
const places = r.data.places;
assert.equal(places.length, 6, places.map((p) => p.name).join(", "));
const lucali = byName(places, "Lucali");
r = await call(`/api/places/${lucali.id}`, { method: "PATCH", body: { visit_status: "visited", my_rating: 5, notes: "Bring cash" } });
assert.equal(r.data.place.visit_status, "visited");
assert.ok(r.data.place.visited_at > 0);
r = await call(`/api/places/${lucali.id}`, { method: "PATCH", body: { my_rating: 9 } });
assert.equal(r.status, 400);
step("marks visited with a rating and notes, and validates input");

const shackRow = byName(places, "Shake Shack");
r = await call(`/api/places/${shackRow.id}`, { method: "PATCH", body: { branch_id: "ss_msp" } });
assert.equal(r.data.place.google_place_id, "ss_msp");
r = await call(`/api/places/${shackRow.id}/recheck`, { method: "POST" });
assert.equal(r.data.found, true);
assert.equal(r.data.place.google_place_id, "ss_hs");
step("switches branches by hand and re-checks back to the nearest");

r = await call(`/api/search?q=${encodeURIComponent("Lucali Brooklyn, NY")}`);
assert.equal(r.data.results[0].id, "lucali");
assert.ok(r.data.results[0].distanceM > 1000);
const supper = byName(places, "Secret Supper Club");
r = await call(`/api/places/${supper.id}/select`, { method: "POST", body: { place_id: "lind" } });
assert.equal(r.data.place.located, 1);
assert.equal(r.data.place.name, "L'industrie Pizzeria");
step("searches Google Maps and attaches a location to an unlocated place");

await call("/api/home", { method: "PUT", body: { address: "Lucali Brooklyn, NY" } });
r = await call("/api/state");
assert.ok(byName(r.data.places, "Lucali").distance_m < 50);
assert.equal(byName(r.data.places, "Shake Shack").google_place_id, "ss_msp");
step("moving home switches chains to the branch closest to the new address");
await call("/api/home", { method: "PUT", body: { address: "350 5th Ave, New York" } });
await call(`/api/places/${shackRow.id}/recheck`, { method: "POST" });

r = await call(`/api/places/${supper.id}`, { method: "DELETE" });
assert.equal(r.status, 200);
r = await call("/api/state");
assert.equal(r.data.places.length, 5);
step("deletes a place");

console.log("\nAll end-to-end checks passed.");
