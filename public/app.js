/* Reel Eats: phone app for the restaurant catalog. Plain JS, no build step. */

const CATEGORY_EMOJI = {
  "Pizza": "🍕",
  "Burgers": "🍔",
  "Sandwiches & Deli": "🥪",
  "Tacos & Mexican": "🌮",
  "BBQ": "🍖",
  "Seafood": "🦞",
  "Steakhouse": "🥩",
  "Italian": "🍝",
  "Japanese & Sushi": "🍣",
  "Ramen & Noodles": "🍜",
  "Chinese": "🥟",
  "Korean": "🍲",
  "Thai": "🌶️",
  "Vietnamese": "🥢",
  "Indian": "🍛",
  "Middle Eastern & Mediterranean": "🧆",
  "Latin & Caribbean": "🫓",
  "American & Comfort": "🍗",
  "Breakfast & Brunch": "🥞",
  "Coffee & Cafe": "☕",
  "Bakery & Desserts": "🥐",
  "Bar & Drinks": "🍸",
  "Vegetarian & Vegan": "🥗",
  "Other": "🍽️",
};
const CATEGORIES = Object.keys(CATEGORY_EMOJI);
const emoji = (c) => CATEGORY_EMOJI[c] || "🍽️";

const TOKEN_KEY = "reel-eats-token";
const PREFS_KEY = "reel-eats-prefs";

const state = {
  token: "",
  home: null,
  units: "mi",
  places: [],
  shares: [],
  view: "map",
  status: "want",
  category: "",
  search: "",
  sort: "home",
  me: null,
  sheet: null,
  selectedId: null,
};

/* ---------- small helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const safeUrl = (u) => {
  try {
    const x = new URL(u);
    return x.protocol === "https:" || x.protocol === "http:" ? x.href : "";
  } catch {
    return "";
  }
};
const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* storage unavailable */
    }
  },
};

function fmtDist(m) {
  if (m == null || Number.isNaN(m)) return "";
  if (state.units === "km") return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
  const mi = m / 1609.344;
  return `${mi.toFixed(mi < 10 ? 1 : 0)} mi`;
}

function haversine(aLat, aLng, bLat, bLng) {
  const R = 6371008.8;
  const r = (d) => (d * Math.PI) / 180;
  const h = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLng - aLng) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

let toastTimer;
function toast(msg, ms = 3400) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

class Unauthorized extends Error {}

async function api(path, { method = "GET", body } = {}) {
  const headers = { Authorization: `Bearer ${state.token}` };
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, { method, headers, body: payload });
  } catch {
    throw new Error("Can't reach the server. Check your connection and try again.");
  }
  if (res.status === 401) {
    showLogin("That access code didn't work. Enter it again.");
    throw new Unauthorized("unauthorized");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `Request failed (${res.status}).`);
  return data;
}

function parsePlace(p) {
  const parse = (s, fallback) => {
    try {
      return s ? JSON.parse(s) : fallback;
    } catch {
      return fallback;
    }
  };
  return { ...p, dishes: parse(p.dishes, []), branches: parse(p.branches, []) };
}

/* ---------- data ---------- */
let pollTimer;
const recovering = new Set();

async function refresh({ rerenderSheet = false } = {}) {
  const data = await api("/api/state");
  state.home = data.home;
  state.units = data.units || "mi";
  state.places = (data.places || []).map(parsePlace);
  state.shares = data.shares || [];
  render();
  if (rerenderSheet && state.sheet?.type === "place") openPlace(state.sheet.id, { keepScroll: true });

  clearTimeout(pollTimer);
  if (state.shares.some((s) => s.status === "pending" || s.status === "processing")) {
    pollTimer = setTimeout(() => refresh().catch(() => {}), 4000);
  }
  recoverStale();
}

/** A share whose background job died gets processed while the app is open. */
function recoverStale() {
  const t = Date.now();
  for (const s of state.shares) {
    const stale =
      (s.status === "pending" && t - s.created_at > 20000) ||
      (s.status === "processing" && s.claimed_at && t - s.claimed_at > 125000);
    if (stale && !recovering.has(s.id)) {
      recovering.add(s.id);
      api(`/api/shares/${s.id}/process`, { method: "POST" })
        .then(() => refresh())
        .catch(() => {});
    }
  }
}

function visiblePlaces({ ignoreCategory = false } = {}) {
  return state.places.filter(
    (p) =>
      (state.status === "all" || p.visit_status === state.status) &&
      (ignoreCategory || !state.category || p.category === state.category),
  );
}

function savePrefs() {
  store.set(PREFS_KEY, JSON.stringify({ view: state.view, status: state.status, sort: state.sort }));
}

/* ---------- rendering ---------- */
function render() {
  renderTally();
  renderCategoryFilter();
  if (state.view === "map") renderMap();
  if (state.view === "list") renderList();
  if (state.view === "cats") renderCats();
}

function renderTally() {
  const want = state.places.filter((p) => p.visit_status === "want").length;
  const visited = state.places.length - want;
  $("#tally").textContent = state.places.length ? `${want} to try · ${visited} visited` : "";
}

function renderCategoryFilter() {
  const sel = $("#category-filter");
  const counts = {};
  for (const p of visiblePlaces({ ignoreCategory: true })) counts[p.category] = (counts[p.category] || 0) + 1;
  const used = CATEGORIES.filter((c) => counts[c] || c === state.category);
  sel.innerHTML =
    `<option value="">All categories</option>` +
    used.map((c) => `<option value="${esc(c)}">${emoji(c)} ${esc(c)} (${counts[c] || 0})</option>`).join("");
  sel.value = state.category;
}

function setView(view) {
  state.view = view;
  savePrefs();
  for (const v of ["map", "list", "cats", "settings"]) $(`#view-${v}`).hidden = v !== view;
  document.querySelectorAll(".tabbar button").forEach((b) => {
    if (b.dataset.view === view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  $("#add-btn").hidden = view === "settings";
  if (view === "settings") renderSettings();
  render();
  if (view === "map" && map) setTimeout(() => map.invalidateSize(), 0);
}

/* ---------- map ---------- */
let map, markerLayer, tiles, fitted = false;
const darkQuery = matchMedia("(prefers-color-scheme: dark)");

function setTiles() {
  if (tiles) tiles.remove();
  const style = darkQuery.matches ? "dark_all" : "rastertiles/voyager";
  tiles = L.tileLayer(`https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png`, {
    subdomains: "abcd",
    maxZoom: 20,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);
}

function ensureMap() {
  if (map) return;
  map = L.map("map", { zoomControl: false, zoomSnap: 0.5 }).setView([39.5, -98.35], 4);
  L.control.zoom({ position: "bottomleft" }).addTo(map);
  setTiles();
  darkQuery.addEventListener?.("change", setTiles);
  markerLayer = L.layerGroup().addTo(map);
}

const HOME_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/></svg>';

function renderMap() {
  ensureMap();
  markerLayer.clearLayers();
  const pts = [];
  if (state.home) {
    L.marker([state.home.lat, state.home.lng], {
      icon: L.divIcon({ className: "", html: `<div class="home-pin">${HOME_SVG}</div>`, iconSize: [34, 34], iconAnchor: [17, 17] }),
      title: "Home",
      zIndexOffset: 1000,
    }).addTo(markerLayer);
  }
  const shown = visiblePlaces().filter((p) => p.located && p.lat != null);
  for (const p of shown) {
    pts.push([p.lat, p.lng]);
    const cls = `pin${p.visit_status === "visited" ? " visited" : ""}${state.selectedId === p.id ? " selected" : ""}`;
    L.marker([p.lat, p.lng], {
      icon: L.divIcon({ className: "", html: `<div class="${cls}"><span>${emoji(p.category)}</span></div>`, iconSize: [36, 36], iconAnchor: [18, 43] }),
      title: p.name,
      keyboard: true,
    })
      .on("click", () => openPlace(p.id))
      .addTo(markerLayer);
  }

  const card = $("#map-card");
  if (!state.home) {
    card.innerHTML = `<strong>Where's home?</strong><p>Add your address so every chain shows the branch closest to you.</p><div><button class="btn primary small" type="button" data-go="settings">Set home address</button></div>`;
    card.hidden = false;
  } else if (!state.places.length) {
    card.innerHTML = `<strong>Your map is empty</strong><p>Share a reel to Reel Eats, or tap Add and paste a link.</p>`;
    card.hidden = false;
  } else if (!shown.length) {
    card.innerHTML = `<strong>Nothing to show</strong><p>No places match these filters.</p>`;
    card.hidden = false;
  } else {
    card.hidden = true;
  }

  if (!fitted && (pts.length || state.home)) {
    fitAll();
    fitted = true;
  }
}

function fitAll() {
  if (!map) return;
  const pts = visiblePlaces()
    .filter((p) => p.located && p.lat != null)
    .map((p) => [p.lat, p.lng]);
  if (state.home) pts.push([state.home.lat, state.home.lng]);
  if (pts.length > 1) map.fitBounds(pts, { padding: [48, 48], maxZoom: 15 });
  else if (pts.length === 1) map.setView(pts[0], 13);
}

/* ---------- list ---------- */
function matchesSearch(p, q) {
  if (!q) return true;
  const hay = [p.name, p.cuisine, p.city, p.address, p.summary, p.notes, p.category, ...(p.dishes || [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
}

function distanceFor(p) {
  if (state.sort === "me" && state.me && p.lat != null) return haversine(state.me.lat, state.me.lng, p.lat, p.lng);
  return p.distance_m;
}

function sortPlaces(list) {
  const byDist = (a, b) => (distanceFor(a) ?? Infinity) - (distanceFor(b) ?? Infinity);
  if (state.sort === "new") return list.sort((a, b) => b.created_at - a.created_at);
  if (state.sort === "name") return list.sort((a, b) => a.name.localeCompare(b.name));
  return list.sort(byDist);
}

function placeCard(p) {
  const visited = p.visit_status === "visited";
  const sub = [p.cuisine || p.category, p.city || p.city_hint].filter(Boolean).join(" · ");
  const pills = [];
  if (visited) pills.push(`<span class="pill visited">Visited${p.my_rating ? ` · ${"★".repeat(p.my_rating)}` : ""}</span>`);
  if (!p.located) pills.push(`<span class="pill warn">No location</span>`);
  else if (p.branch_count > 1) pills.push(`<span class="pill">${p.branch_count} locations</span>`);
  if (p.business_status === "CLOSED_TEMPORARILY") pills.push(`<span class="pill warn">Temporarily closed</span>`);
  const d = p.located ? fmtDist(distanceFor(p)) : "";
  return `<button type="button" class="place-card${visited ? " visited" : ""}" data-open="${esc(p.id)}">
    <div class="glyph" aria-hidden="true">${emoji(p.category)}</div>
    <div><div class="title">${esc(p.name)}</div><div class="sub">${esc(sub)}</div></div>
    <div class="meta">${d ? `<div class="distance">${esc(d)}</div>` : ""}${pills.join("")}</div>
  </button>`;
}

function inboxCard(s) {
  const src = s.note || s.source_author || s.source_url || s.shared_text || "Screenshot";
  if (s.status === "failed") {
    return `<div class="inbox-card failed">
      <div class="row"><span class="pill warn">Needs a name</span><span class="src">${esc(ago(s.created_at))}</span></div>
      <div class="src">${esc(src)}</div>
      <div class="err">${esc(s.error || "Couldn't identify the restaurant.")}</div>
      <form class="row" data-retry="${esc(s.id)}">
        <input type="text" name="note" placeholder="Restaurant name, city" aria-label="Restaurant name" value="${esc(s.note || "")}" />
        <button class="btn primary small" type="submit">Retry</button>
      </form>
      <div class="btn-row">
        ${safeUrl(s.source_url) ? `<a class="btn small" href="${esc(safeUrl(s.source_url))}" target="_blank" rel="noopener">Open post</a>` : ""}
        <button class="btn small danger" type="button" data-dismiss="${esc(s.id)}">Dismiss</button>
      </div>
    </div>`;
  }
  return `<div class="inbox-card">
    <div class="row"><div class="spinner" aria-hidden="true"></div><strong>Finding the restaurant…</strong></div>
    <div class="src">${esc(src)}</div>
  </div>`;
}

function renderList() {
  const el = $("#list");
  const q = state.search.trim();
  let html = "";
  if (state.shares.length) {
    html += `<div class="section-label">Just shared</div><div class="cards">${state.shares.map(inboxCard).join("")}</div>`;
  }
  if (!state.places.length) {
    html += emptyState();
  } else {
    const items = sortPlaces(visiblePlaces().filter((p) => matchesSearch(p, q)));
    const label = { want: "To try", visited: "Visited", all: "All places" }[state.status];
    const cat = state.category ? ` · ${state.category}` : "";
    html += `<div class="section-label">${esc(label + cat)} · <span class="num">${items.length}</span></div>`;
    html += items.length
      ? `<div class="cards">${items.map(placeCard).join("")}</div>`
      : `<div class="empty"><h2>No matches</h2><p>Try another search, or switch between To try, Visited and All.</p></div>`;
  }
  el.innerHTML = html;
}

function emptyState() {
  return `<div class="empty">
    <h2>Nothing saved yet</h2>
    <p>When a reel shows a place you want to try, tap Share in Instagram and pick Reel Eats. You can also tap Add and paste the link.</p>
    <button class="btn" type="button" data-go="settings">How to set up sharing</button>
  </div>`;
}

/* ---------- categories ---------- */
function renderCats() {
  const groups = {};
  for (const p of visiblePlaces({ ignoreCategory: true })) (groups[p.category] ||= []).push(p);
  const cats = CATEGORIES.filter((c) => groups[c]).sort((a, b) => groups[b].length - groups[a].length);
  const label = { want: "To try", visited: "Visited", all: "All places" }[state.status];
  $("#cats").innerHTML = cats.length
    ? `<div class="section-label">${esc(label)} by category</div><div class="cat-grid">${cats
        .map((c) => {
          const list = sortPlaces([...groups[c]]);
          return `<button type="button" class="cat-tile" data-cat="${esc(c)}">
            <span class="emoji" aria-hidden="true">${emoji(c)}</span>
            <span class="name">${esc(c)}</span>
            <span class="count">${list.length} ${list.length === 1 ? "place" : "places"}</span>
            <span class="names">${esc(list.map((p) => p.name).slice(0, 3).join(", "))}</span>
          </button>`;
        })
        .join("")}</div>`
    : state.places.length
      ? `<div class="empty"><h2>Nothing here</h2><p>No places match this filter.</p></div>`
      : emptyState();
}

/* ---------- settings ---------- */
function renderSettings() {
  const origin = location.origin;
  $("#settings").innerHTML = `
    <section class="panel">
      <h2>Home</h2>
      <p>${state.home ? `Distances are measured from <strong>${esc(state.home.address)}</strong>.` : "Set your address so chains show the branch closest to you."}</p>
      <form class="stack" id="home-form">
        <label>Home address
          <input type="text" id="home-address" autocomplete="street-address" placeholder="123 Main St, Springfield" value="${esc(state.home?.address || "")}" />
        </label>
        <div class="btn-row"><button class="btn primary" type="submit">Save home</button></div>
      </form>
      <div class="segmented" role="group" aria-label="Distance units">
        <button type="button" data-units="mi" aria-pressed="${state.units === "mi"}">Miles</button>
        <button type="button" data-units="km" aria-pressed="${state.units === "km"}">Kilometers</button>
      </div>
    </section>

    <section class="panel">
      <h2>Share from Instagram</h2>
      <p><strong>iPhone:</strong> build the Reel Eats shortcut once (steps are in the README). It shows up in Instagram's share menu. It needs these two values:</p>
      <div class="stack">
        <div><div class="hint">Share address</div><div class="code" id="share-endpoint">${esc(origin)}/api/share?format=text</div></div>
        <div class="btn-row">
          <button class="btn small" type="button" data-copy="share-endpoint">Copy address</button>
          <button class="btn small" type="button" data-copy-token>Copy access code</button>
        </div>
      </div>
      <p><strong>Android:</strong> open this site in Chrome, tap the menu, then Install app. Reel Eats then appears in the share menu.</p>
    </section>

    <section class="panel">
      <h2>Your list</h2>
      <p>After moving, re-check every chain for the branch closest to your new home. This runs a Google search per place.</p>
      <div class="btn-row">
        <button class="btn" type="button" id="recheck-btn" ${state.places.length && state.home ? "" : "disabled"}>Re-check nearest branches</button>
      </div>
      <div class="hint" id="recheck-status"></div>
      <p>Keep a copy of your list outside the app.</p>
      <div class="btn-row">
        <button class="btn" type="button" data-export="csv">Export CSV</button>
        <button class="btn" type="button" data-export="json">Export JSON</button>
      </div>
    </section>

    <section class="panel">
      <h2>This phone</h2>
      <p>Signing out removes the access code from this phone. Your list stays saved.</p>
      <div class="btn-row"><button class="btn danger" type="button" id="signout-btn">Sign out</button></div>
    </section>`;
}

async function saveHome(address) {
  const btn = $("#home-form button[type=submit]");
  btn.disabled = true;
  btn.textContent = "Finding address…";
  try {
    const { home } = await api("/api/home", { method: "PUT", body: { address } });
    state.home = home;
    fitted = false;
    await refresh();
    renderSettings();
    toast(`Home set to ${home.address}. Distances updated.`);
  } catch (e) {
    if (!(e instanceof Unauthorized)) toast(e.message);
    btn.disabled = false;
    btn.textContent = "Save home";
  }
}

async function recheckAll() {
  const btn = $("#recheck-btn");
  const status = $("#recheck-status");
  btn.disabled = true;
  let moved = 0;
  const list = [...state.places];
  for (let i = 0; i < list.length; i++) {
    status.textContent = `Checking ${i + 1} of ${list.length}: ${list[i].name}`;
    try {
      const before = list[i].google_place_id;
      const r = await api(`/api/places/${list[i].id}/recheck`, { method: "POST" });
      if (r.found && r.place.google_place_id !== before) moved++;
    } catch (e) {
      if (e instanceof Unauthorized) return;
    }
  }
  status.textContent = `Done. ${moved} ${moved === 1 ? "place switched" : "places switched"} to a closer branch.`;
  btn.disabled = false;
  await refresh();
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function exportList(kind) {
  const rows = state.places.map((p) => ({
    name: p.name,
    category: p.category,
    cuisine: p.cuisine || "",
    status: p.visit_status,
    my_rating: p.my_rating ?? "",
    address: p.address || "",
    city: p.city || p.city_hint || "",
    lat: p.lat ?? "",
    lng: p.lng ?? "",
    distance_from_home: p.located ? fmtDist(p.distance_m) : "",
    locations_found: p.branch_count,
    google_maps: p.maps_url || "",
    website: p.website || "",
    phone: p.phone || "",
    dishes: (p.dishes || []).join("; "),
    summary: p.summary || "",
    notes: p.notes || "",
    post: p.source_url || "",
    saved: new Date(p.created_at).toISOString(),
  }));
  if (kind === "json") return download("reel-eats.json", JSON.stringify(rows, null, 2), "application/json");
  const cols = Object.keys(rows[0] || { name: "" });
  const cell = (v) => `"${String(v).replace(/"/g, '""')}"`;
  download("reel-eats.csv", [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n"), "text/csv");
}

/* ---------- sheet ---------- */
function openSheet(html, info) {
  const sheet = $("#sheet");
  sheet.innerHTML = html;
  sheet.hidden = false;
  $("#backdrop").hidden = false;
  state.sheet = info;
}

function closeSheet() {
  $("#sheet").hidden = true;
  $("#backdrop").hidden = true;
  state.sheet = null;
  if (state.selectedId) {
    state.selectedId = null;
    if (state.view === "map") renderMap();
  }
}

function sheetHead(title, kicker) {
  return `<div class="sheet-head">
    <div><h2 id="sheet-title">${esc(title)}</h2>${kicker ? `<div class="kicker">${kicker}</div>` : ""}</div>
    <button class="round-btn sheet-close" type="button" data-act="close" aria-label="Close">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
  </div>`;
}

const ICON = {
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0112 2.5a7 7 0 017 7C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6A19.8 19.8 0 012.1 4.2 2 2 0 014.1 2h3a2 2 0 012 1.7c.1.9.4 1.8.7 2.7a2 2 0 01-.5 2.1L8 9.8a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.4c.9.3 1.8.6 2.7.7a2 2 0 011.7 2z"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>',
};

function openPlace(id, { keepScroll = false } = {}) {
  const p = state.places.find((x) => x.id === id);
  if (!p) return closeSheet();
  const prevScroll = keepScroll ? $("#sheet .sheet-body")?.scrollTop : 0;
  state.selectedId = id;
  if (state.view === "map") renderMap();

  const visited = p.visit_status === "visited";
  const maps = safeUrl(p.maps_url) || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([p.name, p.address || p.city_hint].filter(Boolean).join(" "))}`;
  const apple = p.located
    ? `https://maps.apple.com/?q=${encodeURIComponent(p.name)}&ll=${p.lat},${p.lng}`
    : `https://maps.apple.com/?q=${encodeURIComponent([p.name, p.city_hint].filter(Boolean).join(" "))}`;
  const post = safeUrl(p.source_url);
  const site = safeUrl(p.website);
  const kicker = `${emoji(p.category)} ${esc(p.category)}${p.cuisine ? ` · ${esc(p.cuisine)}` : ""}`;

  const facts = [];
  if (p.located) {
    const dist = p.distance_m != null ? `${fmtDist(p.distance_m)} from home` : "";
    const branches = p.branch_count > 1 ? `Closest of ${p.branch_count} locations found` : "";
    facts.push(
      `<div class="fact">${ICON.pin}<div>${esc(p.address)}<div class="muted">${esc([dist, branches].filter(Boolean).join(" · "))}</div></div></div>`,
    );
  }
  if (p.rating) {
    facts.push(
      `<div class="fact">${ICON.star}<div>${p.rating.toFixed(1)} on Google <span class="muted num">(${(p.rating_count || 0).toLocaleString()} reviews)</span>${p.price_level ? ` · ${esc(p.price_level)}` : ""}</div></div>`,
    );
  }
  if (p.phone) facts.push(`<div class="fact">${ICON.phone}<div><a href="tel:${esc(p.phone.replace(/[^\d+]/g, ""))}">${esc(p.phone)}</a></div></div>`);
  if (p.business_status && p.business_status !== "OPERATIONAL") {
    facts.push(`<div class="fact">${ICON.alert}<div><span class="pill warn">${p.business_status === "CLOSED_TEMPORARILY" ? "Temporarily closed" : "May be closed"}</span></div></div>`);
  }

  const stars = [1, 2, 3, 4, 5]
    .map((n) => `<button type="button" data-act="rate" data-n="${n}" class="${(p.my_rating || 0) >= n ? "on" : ""}" aria-label="${n} star${n > 1 ? "s" : ""}">★</button>`)
    .join("");

  const branches = p.branches || [];
  const branchList =
    branches.length > 1
      ? `<details class="more"><summary>All ${branches.length} locations</summary><div class="branch-list">${branches
          .map((b) => {
            const d = state.home ? fmtDist(haversine(state.home.lat, state.home.lng, b.lat, b.lng)) : "";
            return `<button type="button" class="branch${b.id === p.google_place_id ? " current" : ""}" data-act="branch" data-id="${esc(b.id)}">
              <div><div>${esc(b.name)}</div><div class="addr">${esc(b.address)}</div></div><div class="distance">${esc(d)}</div></button>`;
          })
          .join("")}</div></details>`
      : "";

  const caption = p.source_caption
    ? `<details class="more"><summary>From the post${p.source_author ? ` by ${esc(p.source_author)}` : ""}</summary><div class="caption">${esc(p.source_caption)}</div></details>`
    : "";

  const html = `${sheetHead(p.name, kicker)}
  <div class="sheet-body">
    <div class="btn-row">
      <a class="btn primary" href="${esc(maps)}" target="_blank" rel="noopener">Google Maps</a>
      <a class="btn" href="${esc(apple)}" target="_blank" rel="noopener">Apple Maps</a>
      ${post ? `<a class="btn" href="${esc(post)}" target="_blank" rel="noopener">Watch reel</a>` : ""}
      ${site ? `<a class="btn" href="${esc(site)}" target="_blank" rel="noopener">Website</a>` : ""}
      ${p.located ? `<button class="btn" type="button" data-act="show-on-map">Show on map</button>` : ""}
    </div>

    ${
      p.located
        ? ""
        : `<div class="panel"><h2>Location not found yet</h2><p>Search Google Maps below and pick the right place.</p></div>`
    }
    ${p.summary ? `<p class="summary">${esc(p.summary)}</p>` : ""}
    ${p.dishes?.length ? `<div class="dishes">${p.dishes.map((d) => `<span class="dish">${esc(d)}</span>`).join("")}</div>` : ""}
    ${facts.length ? `<div class="facts">${facts.join("")}</div>` : ""}

    <div class="stack">
      <div class="btn-row">
        <button class="btn ${visited ? "good" : ""}" type="button" data-act="toggle-visit">${visited ? "✓ Visited" : "Mark as visited"}</button>
      </div>
      ${visited ? `<div class="stars" role="group" aria-label="Your rating">${stars}</div>` : ""}
      <label>Your notes
        <textarea id="place-notes" placeholder="What to order, when to go, who to bring">${esc(p.notes || "")}</textarea>
      </label>
    </div>

    ${branchList}

    <details class="more" ${p.located ? "" : "open"}>
      <summary>${p.located ? "Wrong place?" : "Find it on Google Maps"}</summary>
      <form class="stack" data-act-form="search">
        <div class="btn-row" style="flex-wrap:nowrap">
          <input type="search" id="place-search" value="${esc([p.name, p.city_hint].filter(Boolean).join(" "))}" aria-label="Search Google Maps" />
          <button class="btn" type="submit">Search</button>
        </div>
        <div class="branch-list" id="search-results"></div>
      </form>
    </details>

    <details class="more">
      <summary>Edit details</summary>
      <form class="stack" data-act-form="edit">
        <label>Name <input type="text" id="edit-name" value="${esc(p.name)}" /></label>
        <label>Category
          <select class="field" id="edit-category">${CATEGORIES.map((c) => `<option ${c === p.category ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
        </label>
        <label>Cuisine <input type="text" id="edit-cuisine" value="${esc(p.cuisine || "")}" /></label>
        <div class="btn-row"><button class="btn primary" type="submit">Save changes</button></div>
      </form>
    </details>

    ${caption}

    <div class="btn-row"><button class="btn danger" type="button" data-act="delete">Delete from list</button></div>
  </div>`;
  openSheet(html, { type: "place", id });
  if (prevScroll) $("#sheet .sheet-body").scrollTop = prevScroll;
}

async function patchPlace(id, body, msg) {
  try {
    await api(`/api/places/${id}`, { method: "PATCH", body });
    await refresh({ rerenderSheet: true });
    if (msg) toast(msg);
  } catch (e) {
    if (!(e instanceof Unauthorized)) toast(e.message);
  }
}

/* ---------- adding ---------- */
function openAdd(prefill = {}) {
  openSheet(
    `${sheetHead("Add a place", "Paste a reel link, type a name, or add a screenshot")}
    <div class="sheet-body">
      <form class="stack" id="add-form">
        <label>Reel or post link
          <div class="btn-row" style="flex-wrap:nowrap">
            <input type="url" id="add-url" inputmode="url" placeholder="https://www.instagram.com/reel/…" value="${esc(prefill.url || "")}" />
            <button class="btn" type="button" id="paste-btn">Paste</button>
          </div>
        </label>
        <label>Restaurant name or hint
          <input type="text" id="add-note" placeholder="Tacos Del Norte, Queens" value="${esc(prefill.note || "")}" />
          <span class="hint">Optional with a link. It helps when the caption doesn't name the place.</span>
        </label>
        <label>Screenshot
          <input type="file" id="add-image" accept="image/*" />
          <span class="hint">Optional. A screenshot of the caption or location tag works well.</span>
        </label>
        <div class="btn-row"><button class="btn primary" type="submit">Save place</button></div>
      </form>
    </div>`,
    { type: "add" },
  );
}

async function imageToJpegBase64(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.82));
    return { image_base64: await blobToBase64(blob), image_type: "image/jpeg" };
  } catch {
    return { image_base64: await blobToBase64(file), image_type: file.type };
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("Couldn't read that image."));
    r.readAsDataURL(blob);
  });
}

function resultSheet(title, body, info) {
  openSheet(`${sheetHead(title)}<div class="sheet-body">${body}</div>`, info);
}

async function submitShare(payload) {
  resultSheet(
    "Saving…",
    `<div class="inbox-card"><div class="row"><div class="spinner" aria-hidden="true"></div><strong>Reading the post and finding the closest branch</strong></div>
     <div class="src">${esc(payload.url || payload.note || payload.text || "Screenshot")}</div>
     <p class="hint">This usually takes 10 to 30 seconds. You can close this; the place will show up in your list.</p></div>`,
    { type: "working" },
  );
  let r;
  try {
    r = await api("/api/share?wait=1", { method: "POST", body: payload });
  } catch (e) {
    if (e instanceof Unauthorized) return;
    if (state.sheet?.type === "working") resultSheet("Couldn't save", `<p>${esc(e.message)}</p>`, { type: "result" });
    else toast(e.message);
    return;
  }
  await refresh().catch(() => {});
  const stillOpen = state.sheet?.type === "working";
  const saved = (r.places || []).map(parsePlace);
  const dupes = (r.duplicates || []).map(parsePlace);

  if (!stillOpen) return toast(r.message);
  if (r.status === "failed") {
    resultSheet(
      "Which restaurant is it?",
      `<p>${esc(r.share?.error || r.message)}</p>
       <form class="stack" data-retry="${esc(r.share_id)}">
         <label>Restaurant name <input type="text" name="note" placeholder="Name, and city if you know it" /></label>
         <div class="btn-row"><button class="btn primary" type="submit">Try again</button></div>
       </form>`,
      { type: "result" },
    );
    return;
  }
  if (saved.length === 1 && !dupes.length) {
    toast(r.message);
    return openPlace(saved[0].id);
  }
  const cards = [...saved, ...dupes].map(placeCard).join("");
  resultSheet(saved.length ? "Saved" : "Already saved", `<p>${esc(r.message)}</p>${cards ? `<div class="cards">${cards}</div>` : ""}`, { type: "result" });
}

async function retryShare(id, note) {
  if (!note) return toast("Type the restaurant's name first.");
  const payload = { note };
  resultSheet("Trying again…", `<div class="inbox-card"><div class="row"><div class="spinner"></div><strong>Looking up ${esc(note)}</strong></div></div>`, { type: "working" });
  try {
    const r = await api(`/api/shares/${id}/retry`, { method: "POST", body: payload });
    await refresh();
    if (r.status === "done" && r.places?.length === 1) {
      toast(r.message);
      return openPlace(r.places[0].id);
    }
    resultSheet(r.status === "done" ? "Saved" : "Still stuck", `<p>${esc(r.message)}</p>`, { type: "result" });
  } catch (e) {
    if (!(e instanceof Unauthorized)) resultSheet("Couldn't save", `<p>${esc(e.message)}</p>`, { type: "result" });
  }
}

/* ---------- share target (Android) ---------- */
function readShareParams() {
  if (location.pathname !== "/share") return null;
  const q = new URLSearchParams(location.search);
  const data = { url: q.get("url") || "", text: q.get("text") || "", title: q.get("title") || "" };
  history.replaceState(null, "", "/");
  return data.url || data.text || data.title ? data : null;
}

/* ---------- login ---------- */
let pendingShare = null;

function showLogin(message) {
  $("#login").hidden = false;
  const err = $("#login-error");
  err.textContent = message || "";
  err.hidden = !message;
  setTimeout(() => $("#login-code").focus(), 50);
}

async function login(code) {
  state.token = code.trim();
  try {
    await api("/api/ping");
  } catch (e) {
    if (!(e instanceof Unauthorized)) showLogin(e.message);
    return;
  }
  store.set(TOKEN_KEY, state.token);
  $("#login").hidden = true;
  await refresh().catch((e) => toast(e.message));
  if (pendingShare) {
    const s = pendingShare;
    pendingShare = null;
    submitShare(s);
  }
}

/* ---------- events ---------- */
function bindUI() {
  document.querySelectorAll(".tabbar button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  document.querySelectorAll("[data-status]").forEach((b) =>
    b.addEventListener("click", () => {
      state.status = b.dataset.status;
      document.querySelectorAll("[data-status]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      savePrefs();
      fitted = false;
      render();
    }),
  );
  $("#category-filter").addEventListener("change", (e) => {
    state.category = e.target.value;
    fitted = false;
    render();
  });
  $("#search").addEventListener("input", (e) => {
    state.search = e.target.value;
    renderList();
  });
  $("#sort").addEventListener("change", (e) => {
    state.sort = e.target.value;
    savePrefs();
    if (state.sort === "me") locateMe();
    renderList();
  });
  $("#fit-btn").addEventListener("click", fitAll);
  $("#home-btn").addEventListener("click", () => {
    if (state.home) map.setView([state.home.lat, state.home.lng], 13);
    else setView("settings");
  });
  $("#add-btn").addEventListener("click", () => openAdd());
  $("#backdrop").addEventListener("click", closeSheet);
  document.addEventListener("keydown", (e) => e.key === "Escape" && state.sheet && closeSheet());
  $("#login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    login($("#login-code").value);
  });

  // Delegated clicks for content that gets re-rendered.
  document.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-open],[data-go],[data-cat],[data-dismiss],[data-units],[data-copy],[data-copy-token],[data-export],#recheck-btn,#signout-btn,#paste-btn,[data-act]");
    if (!t) return;
    if (t.dataset.open) return openPlace(t.dataset.open);
    if (t.dataset.go) {
      closeSheet();
      return setView(t.dataset.go);
    }
    if (t.dataset.cat) {
      state.category = t.dataset.cat;
      return setView("list");
    }
    if (t.dataset.dismiss) {
      await api(`/api/shares/${t.dataset.dismiss}`, { method: "DELETE" }).catch(() => {});
      return refresh();
    }
    if (t.dataset.units) {
      await api("/api/settings", { method: "PUT", body: { units: t.dataset.units } }).catch(() => {});
      state.units = t.dataset.units;
      renderSettings();
      return render();
    }
    if (t.dataset.copy !== undefined) return copy($(`#${t.dataset.copy}`).textContent.trim());
    if (t.dataset.copyToken !== undefined) return copy(state.token);
    if (t.dataset.export) return exportList(t.dataset.export);
    if (t.id === "recheck-btn") return recheckAll();
    if (t.id === "signout-btn") {
      store.set(TOKEN_KEY, null);
      state.token = "";
      return showLogin();
    }
    if (t.id === "paste-btn") {
      try {
        $("#add-url").value = (await navigator.clipboard.readText()).trim();
      } catch {
        toast("Long-press the link box and choose Paste.");
      }
      return;
    }
    if (t.dataset.act) return sheetAction(t);
  });

  document.addEventListener("submit", async (e) => {
    const form = e.target;
    if (form.id === "home-form") {
      e.preventDefault();
      const address = $("#home-address").value.trim();
      if (address) saveHome(address);
      return;
    }
    if (form.id === "add-form") {
      e.preventDefault();
      const url = $("#add-url").value.trim();
      const note = $("#add-note").value.trim();
      const file = $("#add-image").files?.[0];
      if (!url && !note && !file) return toast("Paste a link, type a name, or pick a screenshot.");
      const payload = { url, note };
      if (file) Object.assign(payload, await imageToJpegBase64(file));
      return submitShare(payload);
    }
    if (form.dataset.retry) {
      e.preventDefault();
      return retryShare(form.dataset.retry, new FormData(form).get("note")?.toString().trim());
    }
    if (form.dataset.actForm === "search") {
      e.preventDefault();
      return searchGoogle($("#place-search").value.trim());
    }
    if (form.dataset.actForm === "edit") {
      e.preventDefault();
      return patchPlace(
        state.sheet.id,
        { name: $("#edit-name").value, category: $("#edit-category").value, cuisine: $("#edit-cuisine").value },
        "Saved.",
      );
    }
  });

  document.addEventListener("change", (e) => {
    if (e.target.id === "place-notes" && state.sheet?.type === "place") {
      patchPlace(state.sheet.id, { notes: e.target.value }, "Notes saved.");
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.token) refresh().catch(() => {});
  });
}

let deleteArmed = 0;
async function sheetAction(t) {
  const act = t.dataset.act;
  const id = state.sheet?.id;
  if (act === "close") return closeSheet();
  const p = state.places.find((x) => x.id === id);
  if (!p) return;
  if (act === "toggle-visit") {
    const next = p.visit_status === "visited" ? "want" : "visited";
    return patchPlace(id, { visit_status: next }, next === "visited" ? "Marked as visited." : "Moved back to To try.");
  }
  if (act === "rate") return patchPlace(id, { my_rating: Number(t.dataset.n) });
  if (act === "branch") return patchPlace(id, { branch_id: t.dataset.id }, "Switched location.");
  if (act === "show-on-map") {
    closeSheet();
    setView("map");
    state.selectedId = id;
    map.setView([p.lat, p.lng], 15);
    renderMap();
    return;
  }
  if (act === "pick") {
    try {
      await api(`/api/places/${id}/select`, { method: "POST", body: { place_id: t.dataset.id } });
      await refresh({ rerenderSheet: true });
      toast("Location updated.");
    } catch (e) {
      if (!(e instanceof Unauthorized)) toast(e.message);
    }
    return;
  }
  if (act === "delete") {
    if (Date.now() - deleteArmed > 4000) {
      deleteArmed = Date.now();
      t.textContent = "Tap again to delete";
      return;
    }
    deleteArmed = 0;
    await api(`/api/places/${id}`, { method: "DELETE" }).catch(() => {});
    closeSheet();
    toast(`Deleted ${p.name}.`);
    return refresh();
  }
}

async function searchGoogle(q) {
  const box = $("#search-results");
  if (!q || !box) return;
  box.innerHTML = `<div class="row" style="display:flex;gap:8px;align-items:center"><div class="spinner"></div>Searching…</div>`;
  try {
    const { results } = await api(`/api/search?q=${encodeURIComponent(q)}`);
    box.innerHTML = results.length
      ? results
          .map(
            (r) => `<button type="button" class="branch" data-act="pick" data-id="${esc(r.id)}">
              <div><div>${esc(r.name)}</div><div class="addr">${esc(r.address)}</div></div>
              <div class="distance">${esc(fmtDist(r.distanceM))}</div></button>`,
          )
          .join("")
      : `<p class="hint">No results. Try adding the city.</p>`;
  } catch (e) {
    if (!(e instanceof Unauthorized)) box.innerHTML = `<p class="error-text">${esc(e.message)}</p>`;
  }
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied.");
  } catch {
    toast("Couldn't copy. Long-press to select it instead.");
  }
}

function locateMe() {
  if (!navigator.geolocation) return toast("This phone can't share its location.");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.me = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      renderList();
    },
    () => {
      toast("Location is off, so the list is sorted by distance from home.");
      state.sort = "home";
      $("#sort").value = "home";
      renderList();
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
  );
}

/* ---------- boot ---------- */
async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  try {
    const prefs = JSON.parse(store.get(PREFS_KEY) || "{}");
    if (["map", "list", "cats"].includes(prefs.view)) state.view = prefs.view;
    if (["want", "visited", "all"].includes(prefs.status)) state.status = prefs.status;
    if (["home", "new", "name"].includes(prefs.sort)) state.sort = prefs.sort;
  } catch {
    /* ignore */
  }
  document.querySelectorAll("[data-status]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.status === state.status)));
  $("#sort").value = state.sort;
  bindUI();

  const shared = readShareParams();
  if (shared) state.view = "list";
  setView(state.view);

  state.token = store.get(TOKEN_KEY) || "";
  if (!state.token) {
    pendingShare = shared;
    return showLogin();
  }
  try {
    await refresh();
  } catch (e) {
    if (e instanceof Unauthorized) {
      pendingShare = shared;
      return;
    }
    toast(e.message);
  }
  if (shared) submitShare(shared);
}

boot();
