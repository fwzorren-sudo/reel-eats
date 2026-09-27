/* Reel Eats: phone app for the restaurant catalog. Plain JS, no build step. */
import { hoursNow } from "./hours.js";
import { toKml } from "./kml.js";

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

/** Occasion tags, in the same order as the server's list. */
const TAG_EMOJI = {
  "date night": "🕯️",
  "coffee date": "☕",
  "brunch": "🥞",
  "work-friendly": "💻",
  "outdoor seating": "🌳",
  "rooftop": "🏙️",
  "views": "🌅",
  "late night": "🌙",
  "quick bite": "⚡",
  "cheap eats": "💵",
  "splurge": "💎",
  "family-friendly": "👨‍👩‍👧",
  "groups": "👯",
  "dog-friendly": "🐕",
  "vegetarian-friendly": "🥦",
  "cocktails": "🍹",
  "live music": "🎷",
  "takeout": "🥡",
};
const TAGS = Object.keys(TAG_EMOJI);

const TOKEN_KEY = "reel-eats-token";
const PREFS_KEY = "reel-eats-prefs";
const BANNER_KEY = "reel-eats-banner";
const SCOPE_LABEL = { want: "To try", visited: "Visited", all: "All places" };

const state = {
  token: "",
  home: null,
  units: "mi",
  places: [],
  shares: [],
  /** Reels that recommended each place, by place id. */
  sources: {},
  viewer: { role: "owner", name: null },
  apify: null,
  view: "map",
  browse: "cats",
  status: "want",
  category: "",
  city: "",
  tag: "",
  goSoon: false,
  openNow: false,
  search: "",
  sort: "home",
  me: null,
  sheet: null,
  selectedId: null,
  features: { engine: "rules", screenshots: false, apify: false, transcripts: false },
  /** Set when viewing someone's read-only link. */
  guest: null,
};

/* ---------- small helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const enc = encodeURIComponent;
const safeUrl = (u) => {
  try {
    const x = new URL(u);
    return x.protocol === "https:" || x.protocol === "http:" ? x.href : "";
  } catch {
    return "";
  }
};
const media = (key) => (key && /^[0-9a-f-]{36}$/.test(key) ? `/api/media/${key}` : "");
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
const isOwner = () => !state.guest && state.viewer.role === "owner";

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

function fmtDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
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
  return { ...p, dishes: parse(p.dishes, []), branches: parse(p.branches, []), tags: parse(p.tags, []), hours: parse(p.hours, null) };
}

function groupSources(list) {
  const out = {};
  for (const s of list || []) (out[s.place_id] ||= []).push(s);
  return out;
}

/** "New opening" notes go stale; pop-ups and limited-time items sooner. */
function goSoonActive(p) {
  if (!p.go_soon) return false;
  const since = p.posted_at || p.created_at;
  const days = (Date.now() - since) / 86400000;
  return days < (/pop-?up|limited|seasonal|through/i.test(p.go_soon) ? 45 : 120);
}

const cityOf = (p) => (p.city || p.city_hint || "").trim();
const closedForGood = (p) => p.business_status === "CLOSED_PERMANENTLY";
const openNow = (p) => !!hoursNow(p)?.open;

function creatorsFor(p) {
  const list = state.sources[p.id] || [];
  return new Set(list.map((s) => (s.source_author || s.source_url || s.created_at).toString().toLowerCase())).size;
}

/* ---------- data ---------- */
let pollTimer;
const recovering = new Set();

function applyData(data) {
  state.home = data.home || null;
  state.units = data.units || "mi";
  state.places = (data.places || []).map(parsePlace);
  state.shares = data.shares || [];
  state.sources = groupSources(data.sources);
  if (data.viewer) state.viewer = data.viewer;
  state.apify = data.apify || null;
  if (data.features) state.features = data.features;
}

async function refresh({ rerenderSheet = false } = {}) {
  if (state.guest) return loadGuest({ rerenderSheet });
  const data = await api("/api/state");
  applyData(data);
  render();
  if (rerenderSheet && state.sheet?.type === "place") openPlace(state.sheet.id, { keepScroll: true });

  clearTimeout(pollTimer);
  if (state.shares.some((s) => s.status === "pending" || s.status === "processing")) {
    pollTimer = setTimeout(() => refresh().catch(() => {}), 4000);
  }
  recoverStale();
}

async function loadGuest({ rerenderSheet = false } = {}) {
  const res = await fetch(`/api/public/${enc(state.guest.token)}`).catch(() => null);
  const data = res ? await res.json().catch(() => ({})) : {};
  if (!res || !res.ok) {
    document.body.classList.add("link-broken");
    $("#main-views").hidden = true;
    $("#guest-missing").hidden = false;
    $("#guest-missing p").textContent = data.error || "Can't reach the server. Check your connection and try again.";
    return;
  }
  state.guest.label = data.label || "";
  // Open on what the link was made for, such as "All places".
  if (!state.guest.loaded && data.scope?.status) {
    state.status = data.scope.status;
    document.querySelectorAll("[data-status]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.status === state.status)));
  }
  state.guest.loaded = true;
  applyData({ ...data, home: null, shares: [] });
  $("#tally").textContent = state.guest.label ? `Shared list · ${state.guest.label}` : "Shared list";
  render();
  if (rerenderSheet && state.sheet?.type === "place") openPlace(state.sheet.id, { keepScroll: true });
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

function visiblePlaces({ ignoreCategory = false, ignoreBrowse = false } = {}) {
  return state.places.filter(
    (p) =>
      (state.status === "all" || p.visit_status === state.status) &&
      (ignoreCategory || !state.category || p.category === state.category) &&
      (!state.openNow || openNow(p)) &&
      (ignoreBrowse || !state.city || cityOf(p) === state.city) &&
      (ignoreBrowse || !state.tag || p.tags.includes(state.tag)) &&
      (ignoreBrowse || !state.goSoon || goSoonActive(p)),
  );
}

function savePrefs() {
  if (state.guest) return;
  store.set(PREFS_KEY, JSON.stringify({ view: state.view, status: state.status, sort: state.sort, browse: state.browse }));
}

/* ---------- rendering ---------- */
function render() {
  renderTally();
  renderCategoryFilter();
  renderBanner();
  $("#open-filter").setAttribute("aria-pressed", String(state.openNow));
  if (state.view === "map") renderMap();
  if (state.view === "list") renderList();
  if (state.view === "cats") renderBrowse();
}

function renderTally() {
  if (state.guest) return;
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
    `<option value="">Category</option>` +
    used.map((c) => `<option value="${esc(c)}">${emoji(c)} ${esc(c)} (${counts[c] || 0})</option>`).join("");
  sel.value = state.category;
}

/** Apify credit: warn when most of the month's credit is used, or it ran out. */
function renderBanner() {
  const el = $("#banner");
  const a = state.apify;
  let msg = "";
  if (a?.blocked) {
    msg = `Apify is out of credit, so reels are read from Instagram's own page for now. It resets ${fmtDate(Date.parse(a.resetsAt))}.`;
  } else if (a?.limit && a.used / a.limit >= 0.8) {
    msg = `Apify credit: $${a.used.toFixed(2)} of $${a.limit.toFixed(2)} used this month. It resets ${fmtDate(Date.parse(a.resetsAt))}.`;
  }
  const key = msg ? `${a.resetsAt}|${a.blocked ? "blocked" : "low"}` : "";
  const hidden = !msg || state.guest || store.get(BANNER_KEY) === key;
  el.hidden = hidden;
  if (!hidden) {
    el.innerHTML = `<span>${esc(msg)}</span><button type="button" class="banner-close" data-banner-close="${esc(key)}" aria-label="Dismiss">✕</button>`;
  }
}

function setView(view) {
  if (view === "settings" && state.guest) view = "map";
  state.view = view;
  savePrefs();
  for (const v of ["map", "list", "cats", "settings"]) $(`#view-${v}`).hidden = v !== view;
  document.querySelectorAll(".tabbar button").forEach((b) => {
    if (b.dataset.view === view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  $("#add-btn").hidden = view === "settings" || !!state.guest;
  if (view === "settings") renderSettings();
  render();
  if (view === "map" && map) setTimeout(() => map.invalidateSize(), 0);
}

/* ---------- map ---------- */
let map, markerLayer, meLayer, tiles, fitted = false;

function setTiles() {
  if (tiles) return;
  // OpenStreetMap's standard tiles need no key. Dark mode tints them with a CSS filter (see styles.css).
  tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    className: "osm-tiles",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
}

function ensureMap() {
  if (map) return;
  map = L.map("map", { zoomControl: false }).setView([39.5, -98.35], 4);
  L.control.zoom({ position: "bottomleft" }).addTo(map);
  setTiles();
  markerLayer = L.layerGroup().addTo(map);
  meLayer = L.layerGroup().addTo(map);
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
    const cls = `pin${p.visit_status === "visited" ? " visited" : ""}${closedForGood(p) ? " closed" : ""}${state.selectedId === p.id ? " selected" : ""}`;
    L.marker([p.lat, p.lng], {
      icon: L.divIcon({ className: "", html: `<div class="${cls}"><span>${emoji(p.category)}</span></div>`, iconSize: [36, 36], iconAnchor: [18, 43] }),
      title: p.name,
      keyboard: true,
    })
      .on("click", () => openPlace(p.id))
      .addTo(markerLayer);
  }

  const card = $("#map-card");
  if (!state.home && !state.guest) {
    card.innerHTML = `<strong>Where's home?</strong><p>Add your address so every chain shows the branch closest to you.</p><div><button class="btn primary small" type="button" data-go="settings">Set home address</button></div>`;
    card.hidden = false;
  } else if (!state.places.length) {
    card.innerHTML = state.guest
      ? `<strong>Nothing here yet</strong><p>This list is empty.</p>`
      : `<strong>Your map is empty</strong><p>Share a reel to Reel Eats, or tap Add and paste a link.</p>`;
    card.hidden = false;
  } else if (!shown.length) {
    card.innerHTML = state.openNow
      ? `<strong>Nothing open right now</strong><p>No places in this view are open at the moment. Turn off Open now to see them all.</p>`
      : `<strong>Nothing to show</strong><p>No places match these filters.</p>`;
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

function showMeOnMap() {
  if (!state.me || !map) return;
  meLayer.clearLayers();
  L.marker([state.me.lat, state.me.lng], {
    icon: L.divIcon({ className: "", html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
    title: "You are here",
    zIndexOffset: 900,
  }).addTo(meLayer);
  map.setView([state.me.lat, state.me.lng], 14);
}

/* ---------- list ---------- */
function matchesSearch(p, q) {
  if (!q) return true;
  const hay = [p.name, p.cuisine, p.city, p.address, p.summary, p.notes, p.category, p.go_soon, p.added_by, p.instagram_handle, ...(p.dishes || []), ...(p.tags || [])]
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

function addedByLabel(p) {
  if (!p.added_by || state.guest) return "";
  return p.added_by === state.viewer.name ? "You" : p.added_by;
}

function thumb(p, size = "") {
  const src = media(p.photo_key);
  return src
    ? `<div class="thumb ${size}" aria-hidden="true"><img src="${esc(src)}" alt="" loading="lazy" decoding="async" /><span class="badge">${emoji(p.category)}</span></div>`
    : `<div class="glyph ${size}" aria-hidden="true">${emoji(p.category)}</div>`;
}

function placeCard(p) {
  const visited = p.visit_status === "visited";
  const sub = [p.cuisine || p.category, cityOf(p)].filter(Boolean).join(" · ");
  const pills = [];
  if (closedForGood(p)) pills.push(`<span class="pill danger">Closed for good</span>`);
  else if (p.business_status === "CLOSED_TEMPORARILY") pills.push(`<span class="pill warn">Temporarily closed</span>`);
  else {
    const h = hoursNow(p);
    if (h) pills.push(`<span class="pill ${h.tone}">${h.tone === "open" ? "Open" : h.tone === "soon" ? "Closes soon" : "Closed"}</span>`);
  }
  if (visited) pills.push(`<span class="pill visited">Visited${p.my_rating ? ` · ${"★".repeat(p.my_rating)}` : ""}</span>`);
  if (!p.located) pills.push(`<span class="pill warn">No location</span>`);
  const d = p.located ? fmtDist(distanceFor(p)) : "";
  const extras = [];
  if (goSoonActive(p) && !visited) extras.push(`<span class="pill hot">⏳ ${esc(p.go_soon)}</span>`);
  const creators = creatorsFor(p);
  if (creators > 1) extras.push(`<span class="pill accent">${creators} creators</span>`);
  const who = addedByLabel(p);
  if (who) extras.push(`<span class="pill">Added by ${esc(who)}</span>`);
  return `<button type="button" class="place-card${visited ? " visited" : ""}${closedForGood(p) ? " gone" : ""}" data-open="${esc(p.id)}">
    ${thumb(p)}
    <div class="main"><div class="title">${esc(p.name)}</div><div class="sub">${esc(sub)}</div>${extras.length ? `<div class="extras">${extras.join("")}</div>` : ""}</div>
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

function activeFilters() {
  const chips = [];
  if (state.city) chips.push(`<button type="button" class="chip on" data-clear="city">📍 ${esc(state.city)} <span aria-hidden="true">✕</span></button>`);
  if (state.tag) chips.push(`<button type="button" class="chip on" data-clear="tag">${TAG_EMOJI[state.tag] || ""} ${esc(state.tag)} <span aria-hidden="true">✕</span></button>`);
  if (state.goSoon) chips.push(`<button type="button" class="chip on" data-clear="goSoon">⏳ Go soon <span aria-hidden="true">✕</span></button>`);
  return chips.length ? `<div class="chip-row" aria-label="Active filters">${chips.join("")}</div>` : "";
}

function renderList() {
  const el = $("#list");
  const q = state.search.trim();
  let html = activeFilters();
  if (state.shares.length) {
    html += `<div class="section-label">Just shared</div><div class="cards">${state.shares.map(inboxCard).join("")}</div>`;
  }
  const closed = state.places.filter((p) => closedForGood(p) && p.visit_status === "want");
  if (closed.length && !state.guest) {
    html += `<div class="notice"><strong>${closed.length === 1 ? "A place on your list has" : `${closed.length} places on your list have`} closed for good</strong>
      <div class="btn-row">${closed.map((p) => `<button class="btn small" type="button" data-open="${esc(p.id)}">${esc(p.name)}</button>`).join("")}</div></div>`;
  }
  if (!state.places.length) {
    html += emptyState();
  } else {
    const items = sortPlaces(visiblePlaces().filter((p) => matchesSearch(p, q)));
    const label = SCOPE_LABEL[state.status];
    const cat = state.category ? ` · ${state.category}` : "";
    const open = state.openNow ? " · open now" : "";
    html += `<div class="section-label">${esc(label + cat + open)} · <span class="num">${items.length}</span></div>`;
    html += items.length
      ? `<div class="cards">${items.map(placeCard).join("")}</div>`
      : `<div class="empty"><h2>No matches</h2><p>${state.openNow ? "Nothing that matches is open right now. Turn off Open now, or" : "Try another search, or"} switch between To try, Visited and All.</p></div>`;
  }
  el.innerHTML = html;
}

function emptyState() {
  if (state.guest) return `<div class="empty"><h2>Nothing here yet</h2><p>This shared list is empty.</p></div>`;
  return `<div class="empty">
    <h2>Nothing saved yet</h2>
    <p>When a reel shows a place you want to try, tap Share in Instagram and pick Reel Eats. You can also tap Add and paste the link.</p>
    <button class="btn" type="button" data-go="settings">How to set up sharing</button>
  </div>`;
}

/* ---------- browse: categories, cities, occasions ---------- */
function tile({ attr, value, icon, name, list }) {
  const names = sortPlaces([...list]).map((p) => p.name);
  return `<button type="button" class="cat-tile" ${attr}="${esc(value)}">
    <span class="emoji" aria-hidden="true">${icon}</span>
    <span class="name">${esc(name)}</span>
    <span class="count">${list.length} ${list.length === 1 ? "place" : "places"}</span>
    <span class="names">${esc(names.slice(0, 3).join(", "))}</span>
  </button>`;
}

function renderBrowse() {
  document.querySelectorAll("[data-browse]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.browse === state.browse)));
  const places = visiblePlaces({ ignoreCategory: state.browse === "cats", ignoreBrowse: true });
  const label = SCOPE_LABEL[state.status];
  let tiles = [];
  let heading = "";
  if (state.browse === "cats") {
    const groups = {};
    for (const p of places) (groups[p.category] ||= []).push(p);
    heading = `${label} by category`;
    tiles = CATEGORIES.filter((c) => groups[c])
      .sort((a, b) => groups[b].length - groups[a].length)
      .map((c) => tile({ attr: "data-cat", value: c, icon: emoji(c), name: c, list: groups[c] }));
  } else if (state.browse === "cities") {
    const groups = {};
    for (const p of places) (groups[cityOf(p) || "Somewhere"] ||= []).push(p);
    heading = `${label} by city`;
    tiles = Object.keys(groups)
      .sort((a, b) => groups[b].length - groups[a].length || a.localeCompare(b))
      .map((c) => tile({ attr: "data-city", value: c === "Somewhere" ? "" : c, icon: "📍", name: c === "Somewhere" ? "No city yet" : c, list: groups[c] }));
  } else {
    heading = `${label} by occasion`;
    const soon = places.filter(goSoonActive);
    if (soon.length && state.status !== "visited") tiles.push(tile({ attr: "data-go-soon", value: "1", icon: "⏳", name: "Go soon", list: soon }));
    for (const t of TAGS) {
      const list = places.filter((p) => p.tags.includes(t));
      if (list.length) tiles.push(tile({ attr: "data-tag", value: t, icon: TAG_EMOJI[t], name: t[0].toUpperCase() + t.slice(1), list }));
    }
  }
  const empty =
    state.browse === "tags"
      ? `<div class="empty"><h2>No occasions yet</h2><p>Places get tags like "date night" or "outdoor seating" when a reel mentions them. You can add tags yourself under Edit details on any place.</p></div>`
      : `<div class="empty"><h2>Nothing here</h2><p>No places match this filter.</p></div>`;
  $("#cats").innerHTML = tiles.length
    ? `<div class="section-label">${esc(heading)}</div><div class="cat-grid">${tiles.join("")}</div>`
    : state.places.length
      ? empty
      : emptyState();
}

/* ---------- settings ---------- */
function renderSettings() {
  const origin = location.origin;
  const a = state.apify;
  const credit =
    a && a.limit
      ? ` This month: $${a.used.toFixed(2)} of $${a.limit.toFixed(2)} of Apify credit used, resets ${esc(fmtDate(Date.parse(a.resetsAt)))}.`
      : "";
  const owner = isOwner();
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
      <h2>How reels are read</h2>
      <p>${
        state.features.apify
          ? `Apify reads each reel's caption, location tag, tagged accounts${state.features.transcripts ? " and what's said in the video" : ""}.${credit}`
          : "Captions come from Instagram's public page, which Instagram sometimes blocks. Adding an Apify token makes this reliable."
      } ${
        {
          claude: "Claude works out which restaurant the reel shows.",
          "workers-ai": "Cloudflare Workers AI and the post's 📍 pins, location tag and @mentions point to the restaurant.",
          rules: "The post's 📍 pins, location tag and @mentions point to the restaurant.",
        }[state.features.engine] || ""
      } Google Maps confirms it and finds the branch closest to home.</p>
    </section>

    ${
      owner
        ? `<section class="panel">
      <h2>Partner access</h2>
      <p>Give someone their own access code. They can add and edit places, and what they save is marked with their name. They can't change these settings. Their code also works in the iPhone Shortcut.</p>
      <div id="members" class="stack"><div class="hint">Loading…</div></div>
      <form class="btn-row" id="member-form" style="flex-wrap:nowrap">
        <input type="text" id="member-name" placeholder="Their name" maxlength="40" aria-label="Their name" />
        <button class="btn" type="submit">Make a code</button>
      </form>
    </section>

    <section class="panel">
      <h2>Share a read-only list</h2>
      <p>Anyone with the link can see these places on a map, without an access code. Your notes, your home and distances stay private.</p>
      <form class="stack" id="link-form">
        <label>Name <span class="hint">Optional</span><input type="text" id="link-label" placeholder="For example, Pizza for Alex" maxlength="60" /></label>
        <div class="btn-row" style="flex-wrap:nowrap">
          <select class="field" id="link-status" aria-label="Which places">
            <option value="want">To try</option><option value="visited">Visited</option><option value="all">All places</option>
          </select>
          <select class="field" id="link-category" aria-label="Category">
            <option value="">Every category</option>${CATEGORIES.map((c) => `<option value="${esc(c)}">${emoji(c)} ${esc(c)}</option>`).join("")}
          </select>
        </div>
        <div class="btn-row"><button class="btn" type="submit">Make a link</button></div>
      </form>
      <div id="links" class="stack"></div>
    </section>`
        : ""
    }

    <section class="panel">
      <h2>Your list</h2>
      <p>After moving, re-check every chain for the branch closest to your new home. This runs a Google search per place.</p>
      <div class="btn-row">
        <button class="btn" type="button" id="recheck-btn" ${state.places.length && state.home ? "" : "disabled"}>Re-check nearest branches</button>
        ${owner ? `<button class="btn" type="button" id="refresh-btn" ${state.places.length ? "" : "disabled"}>Refresh hours and closures</button>` : ""}
      </div>
      <div class="hint" id="recheck-status">${owner ? "Hours, ratings and closures also refresh by themselves about once a month." : ""}</div>
      <p>Keep a copy of your list outside the app, or open it in Google My Maps: create a map there, tap Import, and pick the KML file.</p>
      <div class="btn-row">
        <button class="btn" type="button" data-export="kml">Google My Maps (KML)</button>
        <button class="btn" type="button" data-export="csv">CSV</button>
        <button class="btn" type="button" data-export="json">JSON</button>
      </div>
    </section>

    <section class="panel">
      <h2>This phone</h2>
      <p>${owner ? "Signed in as the list's owner." : `Signed in as ${esc(state.viewer.name || "a partner")}.`} Signing out removes the access code from this phone. Your list stays saved.</p>
      <div class="btn-row"><button class="btn danger" type="button" id="signout-btn">Sign out</button></div>
    </section>`;
  if (owner) {
    loadMembers();
    loadLinks();
  }
}

async function loadMembers(newCode) {
  const box = $("#members");
  if (!box) return;
  try {
    const { members } = await api("/api/members");
    box.innerHTML =
      (newCode
        ? `<div class="new-code"><div class="hint">${esc(newCode.name)}'s access code. It's shown only now, so copy it and send it to them.</div>
             <div class="code" id="new-code">${esc(newCode.code)}</div>
             <div class="btn-row"><button class="btn small" type="button" data-copy="new-code">Copy code</button></div></div>`
        : "") +
      (members.length
        ? members
            .map(
              (m) => `<div class="row-item"><div><strong>${esc(m.name)}</strong><div class="hint">Made ${esc(fmtDate(m.created_at))}</div></div>
                <button class="btn small danger" type="button" data-revoke-member="${esc(m.id)}">Turn off</button></div>`,
            )
            .join("")
        : newCode
          ? ""
          : `<div class="hint">No partner codes yet.</div>`);
  } catch (e) {
    if (!(e instanceof Unauthorized)) box.innerHTML = `<div class="error-text">${esc(e.message)}</div>`;
  }
}

async function loadLinks() {
  const box = $("#links");
  if (!box) return;
  try {
    const { links } = await api("/api/links");
    box.innerHTML = links
      .map((l, i) => {
        const url = `${location.origin}/s/${l.token}`;
        const scope = [SCOPE_LABEL[l.scope.status], l.scope.category].filter(Boolean).join(" · ");
        return `<div class="row-item link-item"><div class="grow"><strong>${esc(l.label || scope)}</strong><div class="hint">${esc(scope)} · made ${esc(fmtDate(l.created_at))}</div>
            <div class="code small" id="link-${i}">${esc(url)}</div></div>
          <div class="btn-row"><button class="btn small" type="button" data-copy="link-${i}">Copy</button><button class="btn small" type="button" data-share-url="${esc(url)}" data-share-title="${esc(l.label || "Reel Eats")}">Share</button>
            <button class="btn small danger" type="button" data-revoke-link="${esc(l.token)}">Turn off</button></div></div>`;
      })
      .join("");
  } catch (e) {
    if (!(e instanceof Unauthorized)) box.innerHTML = `<div class="error-text">${esc(e.message)}</div>`;
  }
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

async function refreshDetails() {
  const btn = $("#refresh-btn");
  const status = $("#recheck-status");
  btn.disabled = true;
  status.textContent = "Checking hours, ratings and closures with Google…";
  try {
    const r = await api("/api/maintenance/refresh", { method: "POST", body: { all: true } });
    const closed = r.closed.length ? ` Closed for good: ${r.closed.join(", ")}.` : "";
    const more = r.checked >= 35 ? " The rest are checked over the next few days." : "";
    status.textContent = `Checked ${r.checked} ${r.checked === 1 ? "place" : "places"}.${closed}${more}`;
    await refresh();
  } catch (e) {
    if (!(e instanceof Unauthorized)) status.textContent = e.message;
  }
  if ($("#refresh-btn")) $("#refresh-btn").disabled = false;
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
  if (kind === "kml") return download("reel-eats.kml", toKml(state.places), "application/vnd.google-earth.kml+xml");
  const rows = state.places.map((p) => ({
    name: p.name,
    category: p.category,
    cuisine: p.cuisine || "",
    status: p.visit_status,
    my_rating: p.my_rating ?? "",
    address: p.address || "",
    city: cityOf(p),
    lat: p.lat ?? "",
    lng: p.lng ?? "",
    distance_from_home: p.located ? fmtDist(p.distance_m) : "",
    locations_found: p.branch_count,
    google_maps: p.maps_url || "",
    website: p.website || "",
    phone: p.phone || "",
    instagram: p.instagram_handle ? `https://www.instagram.com/${p.instagram_handle}/` : "",
    hours: (p.hours?.weekdayDescriptions || []).join("; "),
    business_status: p.business_status || "",
    tags: (p.tags || []).join("; "),
    go_soon: p.go_soon || "",
    dishes: (p.dishes || []).join("; "),
    summary: p.summary || "",
    notes: p.notes || "",
    post: p.source_url || "",
    reels: (state.sources[p.id] || []).map((s) => s.source_url).filter(Boolean).join(" "),
    posted: p.posted_at ? new Date(p.posted_at).toISOString() : "",
    added_by: p.added_by || "",
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
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  person: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
};

/** Where to book. A booking-site website or a booking link in the caption wins; otherwise search. */
function bookingLinks(p) {
  if (!p.located) return [];
  const direct = [safeUrl(p.website), ...((p.source_caption || "").match(/https?:\/\/[^\s]+/g) || [])].find((u) =>
    /^https?:\/\/(?:[\w-]+\.)*(?:resy|opentable|exploretock|tock|sevenrooms)\.com\//i.test(u || ""),
  );
  if (direct) return [{ label: "Reserve a table", href: direct }];
  if (/Coffee|Bakery/.test(p.category) || (p.tags || []).includes("quick bite")) return [];
  return [
    { label: "OpenTable", href: `https://www.opentable.com/s?term=${enc(p.name)}&latitude=${p.lat}&longitude=${p.lng}` },
    { label: "Resy", href: `https://www.google.com/search?q=${enc(`${p.name} ${cityOf(p)} site:resy.com`)}` },
  ];
}

function reelStrip(p) {
  let list = state.sources[p.id] || [];
  if (!list.length && p.source_url) list = [{ source_url: p.source_url, source_author: p.source_author, posted_at: p.posted_at, photo_key: p.photo_key }];
  if (!list.length) return "";
  const n = creatorsFor(p);
  const cards = [...list]
    .sort((a, b) => (b.posted_at || b.created_at || 0) - (a.posted_at || a.created_at || 0))
    .map((s) => {
      const href = safeUrl(s.source_url);
      const img = media(s.photo_key);
      const inner = `<div class="reel-img">${img ? `<img src="${esc(img)}" alt="" loading="lazy" />` : `<span>${emoji(p.category)}</span>`}<span class="play">${ICON.play}</span></div>
        <div class="reel-meta"><strong>${s.source_author ? `@${esc(s.source_author)}` : "Shared text"}</strong><span>${esc(fmtDate(s.posted_at || s.created_at))}</span></div>`;
      return href
        ? `<a class="reel" href="${esc(href)}" target="_blank" rel="noopener" aria-label="Watch the reel${s.source_author ? ` by ${esc(s.source_author)}` : ""}">${inner}</a>`
        : `<div class="reel">${inner}</div>`;
    })
    .join("");
  return `<div class="reels"><div class="section-label">${n > 1 ? `Recommended by ${n} creators` : "From the reel"}</div><div class="reel-strip">${cards}</div></div>`;
}

function hoursFact(p) {
  const h = hoursNow(p);
  if (!h) return "";
  const week = p.hours?.weekdayDescriptions || [];
  // Google lists Monday first; its "today" is 0 = Sunday.
  const todayIdx = (h.today + 6) % 7;
  const rows = week
    .map((line, i) => {
      const [day, ...rest] = line.split(": ");
      return `<div class="hours-row${i === todayIdx ? " today" : ""}"><span>${esc(day)}</span><span>${esc(rest.join(": "))}</span></div>`;
    })
    .join("");
  return `<div class="fact">${ICON.clock}<div><span class="open-text ${h.tone}">${esc(h.text)}</span>${
    rows ? `<details class="hours"><summary>All hours</summary><div class="hours-table">${rows}</div></details>` : ""
  }</div></div>`;
}

function openPlace(id, { keepScroll = false } = {}) {
  const p = state.places.find((x) => x.id === id);
  if (!p) return closeSheet();
  const prevScroll = keepScroll ? $("#sheet .sheet-body")?.scrollTop : 0;
  state.selectedId = id;
  if (state.view === "map") renderMap();
  const guest = !!state.guest;

  const visited = p.visit_status === "visited";
  const maps = safeUrl(p.maps_url) || `https://www.google.com/maps/search/?api=1&query=${enc([p.name, p.address || p.city_hint].filter(Boolean).join(" "))}`;
  const apple = p.located
    ? `https://maps.apple.com/?q=${enc(p.name)}&ll=${p.lat},${p.lng}`
    : `https://maps.apple.com/?q=${enc([p.name, p.city_hint].filter(Boolean).join(" "))}`;
  const site = safeUrl(p.website);
  const ig = p.instagram_handle ? `https://www.instagram.com/${enc(p.instagram_handle)}/` : "";
  const kicker = `${emoji(p.category)} ${esc(p.category)}${p.cuisine ? ` · ${esc(p.cuisine)}` : ""}`;

  const facts = [];
  if (closedForGood(p)) facts.push(`<div class="fact">${ICON.alert}<div><span class="pill danger">Closed for good</span> <span class="muted">Google lists this place as permanently closed.</span></div></div>`);
  if (p.located) {
    const dist = p.distance_m != null && !guest ? `${fmtDist(p.distance_m)} from home` : "";
    const branches = p.branch_count > 1 ? `${guest ? "One" : "Closest"} of ${p.branch_count} locations found` : "";
    facts.push(
      `<div class="fact">${ICON.pin}<div>${esc(p.address)}<div class="muted">${esc([dist, branches].filter(Boolean).join(" · "))}</div></div></div>`,
    );
  }
  if (!closedForGood(p)) facts.push(hoursFact(p));
  if (p.rating) {
    facts.push(
      `<div class="fact">${ICON.star}<div>${p.rating.toFixed(1)} on Google <span class="muted num">(${(p.rating_count || 0).toLocaleString()} reviews)</span>${p.price_level ? ` · ${esc(p.price_level)}` : ""}</div></div>`,
    );
  }
  if (p.phone) facts.push(`<div class="fact">${ICON.phone}<div><a href="tel:${esc(p.phone.replace(/[^\d+]/g, ""))}">${esc(p.phone)}</a></div></div>`);
  if (p.business_status === "CLOSED_TEMPORARILY") {
    facts.push(`<div class="fact">${ICON.alert}<div><span class="pill warn">Temporarily closed</span></div></div>`);
  }
  const who = addedByLabel(p);
  if (who) facts.push(`<div class="fact">${ICON.person}<div class="muted">Added by ${esc(who)}</div></div>`);

  const book = bookingLinks(p);
  const bookRow = book.length && !closedForGood(p)
    ? `<div class="book"><span class="hint">Book a table</span><div class="btn-row">${book.map((b) => `<a class="btn small" href="${esc(b.href)}" target="_blank" rel="noopener">${esc(b.label)}</a>`).join("")}</div></div>`
    : "";

  const tagPills = [
    goSoonActive(p) && !visited ? `<span class="pill hot">⏳ ${esc(p.go_soon)}</span>` : "",
    ...(p.tags || []).map((t) => `<button type="button" class="pill tag" data-tag="${esc(t)}">${TAG_EMOJI[t] || ""} ${esc(t)}</button>`),
  ].filter(Boolean);

  const stars = [1, 2, 3, 4, 5]
    .map((n) => `<button type="button" data-act="rate" data-n="${n}" class="${(p.my_rating || 0) >= n ? "on" : ""}" aria-label="${n} star${n > 1 ? "s" : ""}">★</button>`)
    .join("");

  const branches = p.branches || [];
  const branchList =
    branches.length > 1 && !guest
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

  const tagEditor = TAGS.map(
    (t) => `<label class="check"><input type="checkbox" name="tag" value="${esc(t)}" ${(p.tags || []).includes(t) ? "checked" : ""} /> ${TAG_EMOJI[t]} ${esc(t)}</label>`,
  ).join("");

  const mine = guest
    ? ""
    : `<div class="stack">
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
        <label>Go soon <input type="text" id="edit-go-soon" maxlength="80" placeholder="New opening, pop-up through Oct 12" value="${esc(p.go_soon || "")}" /></label>
        <fieldset class="tag-editor"><legend>Good for</legend>${tagEditor}</fieldset>
        <div class="btn-row"><button class="btn primary" type="submit">Save changes</button></div>
      </form>
    </details>`;

  const html = `${sheetHead(p.name, kicker)}
  <div class="sheet-body">
    ${reelStrip(p)}
    <div class="btn-row">
      <a class="btn primary" href="${esc(maps)}" target="_blank" rel="noopener">Google Maps</a>
      <a class="btn" href="${esc(apple)}" target="_blank" rel="noopener">Apple Maps</a>
      ${ig ? `<a class="btn" href="${esc(ig)}" target="_blank" rel="noopener">@${esc(p.instagram_handle)}</a>` : ""}
      ${site ? `<a class="btn" href="${esc(site)}" target="_blank" rel="noopener">Website</a>` : ""}
      ${p.located ? `<button class="btn" type="button" data-act="show-on-map">Show on map</button>` : ""}
    </div>

    ${
      p.located || guest
        ? ""
        : `<div class="panel"><h2>Location not found yet</h2><p>Search Google Maps below and pick the right place.</p></div>`
    }
    ${tagPills.length ? `<div class="tag-row">${tagPills.join("")}</div>` : ""}
    ${p.summary ? `<p class="summary">${esc(p.summary)}</p>` : ""}
    ${p.dishes?.length ? `<div class="dishes">${p.dishes.map((d) => `<span class="dish">${esc(d)}</span>`).join("")}</div>` : ""}
    ${facts.filter(Boolean).length ? `<div class="facts">${facts.join("")}</div>` : ""}
    ${bookRow}

    ${mine}

    ${caption}

    ${guest ? "" : `<div class="btn-row"><button class="btn danger" type="button" data-act="delete">Delete from list</button></div>`}
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
    `${sheetHead("Add a place", state.features.screenshots ? "Paste a reel link, type a name, or add a screenshot" : "Paste a reel link or type a name")}
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
        ${
          state.features.screenshots
            ? `<label>Screenshot
          <input type="file" id="add-image" accept="image/*" />
          <span class="hint">Optional. A screenshot of the caption or location tag works well.</span>
        </label>`
            : ""
        }
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
     <p class="hint">This usually takes 10 to 40 seconds. You can close this; the place will show up in your list.</p></div>`,
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
  const fresh = (x) => state.places.find((p) => p.id === x.id) || x;
  const cards = [...saved, ...dupes].map((x) => placeCard(fresh(x))).join("");
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
  if (state.guest) return;
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
  document.querySelectorAll("[data-browse]").forEach((b) =>
    b.addEventListener("click", () => {
      state.browse = b.dataset.browse;
      savePrefs();
      renderBrowse();
    }),
  );
  $("#open-filter").addEventListener("click", () => {
    state.openNow = !state.openNow;
    fitted = false;
    render();
    if (state.openNow) toast("Showing places open right now, in each place's local time.");
  });
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
    else if (!state.guest) setView("settings");
  });
  $("#me-btn").addEventListener("click", () => locateMe({ onMap: true }));
  $("#add-btn").addEventListener("click", () => openAdd());
  $("#backdrop").addEventListener("click", closeSheet);
  document.addEventListener("keydown", (e) => e.key === "Escape" && state.sheet && closeSheet());
  $("#login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    login($("#login-code").value);
  });

  // Delegated clicks for content that gets re-rendered.
  document.addEventListener("click", async (e) => {
    const t = e.target.closest(
      "[data-open],[data-go],[data-cat],[data-city],[data-tag],[data-go-soon],[data-clear],[data-dismiss],[data-units],[data-copy],[data-copy-token],[data-export],[data-banner-close],[data-revoke-member],[data-revoke-link],[data-share-url],#recheck-btn,#refresh-btn,#signout-btn,#paste-btn,[data-act]",
    );
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
    if (t.dataset.city !== undefined) {
      state.city = t.dataset.city;
      state.tag = "";
      state.goSoon = false;
      return setView("list");
    }
    if (t.dataset.tag) {
      closeSheet();
      state.tag = t.dataset.tag;
      state.city = "";
      state.goSoon = false;
      return setView("list");
    }
    if (t.dataset.goSoon) {
      state.goSoon = true;
      state.tag = "";
      state.city = "";
      return setView("list");
    }
    if (t.dataset.clear) {
      state[t.dataset.clear] = t.dataset.clear === "goSoon" ? false : "";
      fitted = false;
      return render();
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
    if (t.dataset.bannerClose) {
      store.set(BANNER_KEY, t.dataset.bannerClose);
      return renderBanner();
    }
    if (t.dataset.copy !== undefined) return copy($(`#${t.dataset.copy}`).textContent.trim());
    if (t.dataset.copyToken !== undefined) return copy(state.token);
    if (t.dataset.shareUrl) return shareLink(t.dataset.shareUrl, t.dataset.shareTitle);
    if (t.dataset.export) return exportList(t.dataset.export);
    if (t.dataset.revokeMember) {
      if (!confirmTwice(t, "Tap again to turn off")) return;
      await api(`/api/members/${t.dataset.revokeMember}`, { method: "DELETE" }).catch((err) => toast(err.message));
      toast("Code turned off. It stops working right away.");
      return loadMembers();
    }
    if (t.dataset.revokeLink) {
      if (!confirmTwice(t, "Tap again to turn off")) return;
      await api(`/api/links/${t.dataset.revokeLink}`, { method: "DELETE" }).catch((err) => toast(err.message));
      toast("Link turned off.");
      return loadLinks();
    }
    if (t.id === "recheck-btn") return recheckAll();
    if (t.id === "refresh-btn") return refreshDetails();
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
      const file = $("#add-image")?.files?.[0];
      if (!url && !note && !file) return toast("Paste a link, type a name, or pick a screenshot.");
      const payload = { url, note };
      if (file) Object.assign(payload, await imageToJpegBase64(file));
      return submitShare(payload);
    }
    if (form.id === "member-form") {
      e.preventDefault();
      const name = $("#member-name").value.trim();
      if (!name) return toast("Type the name of the person the code is for.");
      try {
        const r = await api("/api/members", { method: "POST", body: { name } });
        $("#member-name").value = "";
        return loadMembers({ name: r.member.name, code: r.code });
      } catch (err) {
        if (!(err instanceof Unauthorized)) toast(err.message);
      }
      return;
    }
    if (form.id === "link-form") {
      e.preventDefault();
      try {
        const r = await api("/api/links", {
          method: "POST",
          body: { label: $("#link-label").value, status: $("#link-status").value, category: $("#link-category").value },
        });
        $("#link-label").value = "";
        await loadLinks();
        shareLink(`${location.origin}/s/${r.link.token}`, r.link.label || "Reel Eats");
      } catch (err) {
        if (!(err instanceof Unauthorized)) toast(err.message);
      }
      return;
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
      const tags = [...form.querySelectorAll('input[name="tag"]:checked')].map((x) => x.value);
      return patchPlace(
        state.sheet.id,
        { name: $("#edit-name").value, category: $("#edit-category").value, cuisine: $("#edit-cuisine").value, go_soon: $("#edit-go-soon").value, tags },
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
    if (document.visibilityState === "visible" && (state.token || state.guest)) refresh().catch(() => {});
  });
}

const armed = new WeakMap();
/** Destructive buttons need a second tap within four seconds. */
function confirmTwice(btn, label) {
  if (Date.now() - (armed.get(btn) || 0) > 4000) {
    armed.set(btn, Date.now());
    btn.textContent = label;
    return false;
  }
  return true;
}

let deleteArmed = 0;
async function sheetAction(t) {
  const act = t.dataset.act;
  const id = state.sheet?.id;
  if (act === "close") return closeSheet();
  const p = state.places.find((x) => x.id === id);
  if (!p) return;
  if (act === "show-on-map") {
    closeSheet();
    setView("map");
    state.selectedId = id;
    map.setView([p.lat, p.lng], 15);
    renderMap();
    return;
  }
  if (state.guest) return;
  if (act === "toggle-visit") {
    const next = p.visit_status === "visited" ? "want" : "visited";
    return patchPlace(id, { visit_status: next }, next === "visited" ? "Marked as visited." : "Moved back to To try.");
  }
  if (act === "rate") return patchPlace(id, { my_rating: Number(t.dataset.n) });
  if (act === "branch") return patchPlace(id, { branch_id: t.dataset.id }, "Switched location.");
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
    const { results } = await api(`/api/search?q=${enc(q)}`);
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

/** The phone's share menu when there is one, otherwise copy the link. */
async function shareLink(url, title) {
  if (navigator.share) {
    try {
      await navigator.share({ title, url });
      return;
    } catch (e) {
      if (e?.name === "AbortError") return;
    }
  }
  copy(url);
}

function locateMe({ onMap = false } = {}) {
  if (!navigator.geolocation) return toast("This phone can't share its location.");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.me = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (onMap) showMeOnMap();
      if (state.view === "list") renderList();
    },
    () => {
      toast(state.guest || !state.home ? "Location is off." : "Location is off, so the list is sorted by distance from home.");
      if (state.sort === "me") {
        state.sort = state.home ? "home" : "name";
        $("#sort").value = state.sort;
        renderList();
      }
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
  );
}

/* ---------- boot ---------- */
function guestToken() {
  const m = location.pathname.match(/^\/s\/([\w-]{16,64})\/?$/);
  return m ? m[1] : null;
}

async function bootGuest(token) {
  state.guest = { token, label: "" };
  document.body.classList.add("guest");
  $("#sort option[value=home]").remove();
  state.sort = "name";
  $("#sort").value = "name";
  bindUI();
  setView("map");
  await loadGuest();
}

async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  const token = guestToken();
  if (token) return bootGuest(token);

  try {
    const prefs = JSON.parse(store.get(PREFS_KEY) || "{}");
    if (["map", "list", "cats"].includes(prefs.view)) state.view = prefs.view;
    if (["want", "visited", "all"].includes(prefs.status)) state.status = prefs.status;
    if (["home", "new", "name"].includes(prefs.sort)) state.sort = prefs.sort;
    if (["cats", "cities", "tags"].includes(prefs.browse)) state.browse = prefs.browse;
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
