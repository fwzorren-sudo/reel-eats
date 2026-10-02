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

const ARCHIVE_REASONS = { "not-for-me": "Not for me", closed: "Closed", "too-far": "Too far", other: "Other" };

const TOKEN_KEY = "reel-eats-token";
const PREFS_KEY = "reel-eats-prefs";
const BANNER_KEY = "reel-eats-banner";
const THEME_KEY = "reel-eats-theme";

/** Color themes. The colors themselves are in styles.css; these are for the swatches and the phone's status bar. */
const THEMES = [
  { id: "berry", name: "Berry", accent: "#b3306b", darkAccent: "#e56a9f", bg: "#f7f4f6", darkBg: "#151114" },
  { id: "ocean", name: "Ocean", accent: "#1f63ad", darkAccent: "#6aa9ec", bg: "#f3f6f9", darkBg: "#0f1419" },
  { id: "teal", name: "Teal", accent: "#0b6b65", darkAccent: "#4cc2b8", bg: "#f2f7f6", darkBg: "#0e1514" },
  { id: "grape", name: "Grape", accent: "#6a3fc0", darkAccent: "#a888f2", bg: "#f6f4f9", darkBg: "#13111a" },
  { id: "espresso", name: "Espresso", accent: "#8b5130", darkAccent: "#d99a6c", bg: "#f8f5f1", darkBg: "#15110e" },
  { id: "slate", name: "Slate", accent: "#3d4f66", darkAccent: "#9db4d0", bg: "#f4f5f7", darkBg: "#111317" },
];
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
  status: "want",
  category: "",
  city: "",
  openNow: false,
  /** Occasions, "go soon" and "under $20", from the list's icons, More or a tag. Every one has to match. */
  filters: [],
  search: "",
  sort: "home",
  me: null,
  sheet: null,
  selectedId: null,
  features: { engine: "rules", screenshots: false, apify: false, transcripts: false },
  /** Set when viewing someone's read-only link. */
  guest: null,
  /** The list shows archived places instead. */
  archivedView: false,
  /** The pick on the Pick tab: { token, data } from the server, or { token, ended } once it's over. */
  pick: null,
  /** Picks still going, for the Pick tab's setup screen. */
  picks: null,
  pickMode: "relay",
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

function themePrefs() {
  try {
    const t = JSON.parse(store.get(THEME_KEY) || "{}");
    return { mode: ["light", "dark"].includes(t.mode) ? t.mode : "auto", accent: THEMES.some((x) => x.id === t.accent) ? t.accent : "berry" };
  } catch {
    return { mode: "auto", accent: "berry" };
  }
}

/** Light, dark or the phone's setting, plus a color. Kept on this device only. */
function applyTheme(prefs = themePrefs()) {
  const root = document.documentElement;
  if (prefs.mode === "auto") delete root.dataset.theme;
  else root.dataset.theme = prefs.mode;
  if (prefs.accent === "berry") delete root.dataset.accent;
  else root.dataset.accent = prefs.accent;
  const t = THEMES.find((x) => x.id === prefs.accent) || THEMES[0];
  const light = document.querySelector('meta[name="theme-color"][media*="light"]');
  const dark = document.querySelector('meta[name="theme-color"][media*="dark"]');
  if (light) light.content = prefs.mode === "dark" ? t.darkBg : t.bg;
  if (dark) dark.content = prefs.mode === "light" ? t.bg : t.darkBg;
}

function setTheme(change) {
  const prefs = { ...themePrefs(), ...change };
  store.set(THEME_KEY, JSON.stringify(prefs));
  applyTheme(prefs);
}

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
  if (!res.ok) throw Object.assign(new Error(data.error || data.message || `Request failed (${res.status}).`), { status: res.status });
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
const isArchived = (p) => !!p.archived_at;
const archiveLabel = (p) => `Archived${ARCHIVE_REASONS[p.archive_reason] ? ` · ${ARCHIVE_REASONS[p.archive_reason]}` : ""}`;
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
  if (state.guest?.pick) return refreshPick();
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

/** A share whose background job died gets processed while the app is open. Timings match src/db.ts. */
function recoverStale() {
  const t = Date.now();
  for (const s of state.shares) {
    const stored = !s.source_url || !!s.source_caption;
    const stale =
      (s.status === "pending" && t - s.created_at > 20000) ||
      (s.status === "processing" && s.claimed_at && t - s.claimed_at > (stored ? 47000 : 152000));
    if (stale && !recovering.has(s.id)) {
      recovering.add(s.id);
      api(`/api/shares/${s.id}/process`, { method: "POST" })
        .then(() => refresh())
        .catch(() => {});
    }
  }
}

function visiblePlaces({ ignoreCategory = false, ignoreCity = false, filters = state.filters } = {}) {
  return state.places.filter(
    (p) =>
      !isArchived(p) &&
      (state.status === "all" || p.visit_status === state.status) &&
      (ignoreCategory || !state.category || p.category === state.category) &&
      (!state.openNow || openNow(p)) &&
      (ignoreCity || !state.city || cityOf(p) === state.city) &&
      matchesFilters(p, filters),
  );
}

/** What's narrowing the map (and, with a search, the list) beyond To try / Visited / All. */
function filterLabels({ withSearch = false } = {}) {
  return [
    state.category,
    state.city,
    ...state.filters.map((f) => LIST_FILTERS[f]?.label ?? f),
    state.openNow ? "open now" : "",
    withSearch && state.search.trim() ? `"${state.search.trim()}"` : "",
  ].filter(Boolean);
}

/** Back to everything in To try / Visited / All. */
function clearAllFilters() {
  state.category = "";
  state.city = "";
  state.filters = [];
  state.openNow = false;
  state.search = "";
  const box = $("#search");
  if (box) box.value = "";
  fitted = false;
}

/** A tag on a place shows just that tag, instead of adding to what was on before. */
function startFresh() {
  const openNow = state.openNow;
  clearAllFilters();
  state.openNow = openNow;
}

function savePrefs() {
  if (state.guest) return;
  store.set(PREFS_KEY, JSON.stringify({ view: state.view, status: state.status, sort: state.sort }));
}

/* ---------- rendering ---------- */
function render() {
  renderTally();
  renderCategoryFilter();
  renderCityFilter();
  renderBanner();
  $("#open-filter").setAttribute("aria-pressed", String(state.openNow));
  if (state.view === "map") renderMap();
  if (state.view === "list") renderList();
  if (state.view === "pick") renderPick();
}

function renderTally() {
  if (state.guest) return;
  const active = state.places.filter((p) => !isArchived(p));
  const want = active.filter((p) => p.visit_status === "want").length;
  const visited = active.length - want;
  $("#tally").textContent = active.length ? `${want} to try · ${visited} visited` : "";
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

/** Only worth showing when the places are in more than one city. */
function renderCityFilter() {
  const sel = $("#city-filter");
  const counts = {};
  for (const p of visiblePlaces({ ignoreCity: true })) {
    const c = cityOf(p);
    if (c) counts[c] = (counts[c] || 0) + 1;
  }
  const cities = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
  if (state.city && !counts[state.city]) cities.unshift(state.city);
  const everywhere = new Set(state.places.filter((p) => !isArchived(p)).map(cityOf).filter(Boolean));
  sel.hidden = everywhere.size < 2 && !state.city;
  sel.innerHTML = `<option value="">City</option>` + cities.map((c) => `<option value="${esc(c)}">${esc(c)} (${counts[c] || 0})</option>`).join("");
  sel.value = state.city;
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
  if ((view === "settings" || view === "pick") && state.guest && !state.guest.pick) view = "map";
  if (view !== "list") state.archivedView = false;
  state.view = view;
  savePrefs();
  for (const v of ["map", "list", "pick", "settings"]) $(`#view-${v}`).hidden = v !== view;
  document.querySelectorAll(".tabbar button").forEach((b) => {
    if (b.dataset.view === view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  $("#add-btn").hidden = view === "settings" || view === "pick" || !!state.guest;
  document.body.classList.toggle("picking", view === "pick" && !!state.pick);
  if (view === "settings") renderSettings();
  if (view === "pick" && !state.guest) {
    const saved = store.get(PICK_KEY);
    if (!state.pick && saved) openPick(saved, { quiet: saved !== pickLinkOpened });
    if (!state.pick) loadPickList();
  }
  render();
  if (view === "pick" && state.pick?.data) refreshPick();
  else clearTimeout(pickPoll);
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
    const on = filterLabels();
    card.innerHTML = on.length
      ? `<strong>Nothing matches</strong><p>No places in ${esc(SCOPE_LABEL[state.status])} match all of: ${esc(on.join(", "))}.</p><div><button class="btn small" type="button" data-clear-all>Clear all filters</button></div>`
      : `<strong>Nothing to show</strong><p>Switch between To try, Visited and All.</p>`;
    card.hidden = false;
  } else {
    card.hidden = true;
  }
  // The filters are set on the list and in Browse, so the map says which are on.
  const bar = $("#map-filters");
  const on = filterLabels();
  // The card at the top (home not set yet, say) takes the same spot.
  bar.hidden = !on.length || !shown.length || !card.hidden;
  if (!bar.hidden) {
    bar.innerHTML = `<span>${esc(on.join(" · "))} · <span class="num">${shown.length}</span></span><button type="button" class="link-btn" data-clear-all>Clear</button>`;
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

/** The top of Google's price range: 20 for "$10–20", null for "$100+" or none. */
function priceTop(p) {
  const m = (p.price_range || "").match(/(\d+)\D*$/);
  return m && !/\+$/.test(p.price_range) ? Number(m[1]) : null;
}

const LIST_FILTERS = {
  "go-soon": { label: "go soon", test: goSoonActive },
  "date night": { label: "date night" },
  "coffee date": { label: "coffee" },
  cocktails: { label: "cocktails" },
  brunch: { label: "brunch" },
  "outdoor seating": { label: "outdoor" },
  "late night": { label: "late night" },
  "under-20": { label: "under $20", test: (p) => (priceTop(p) ?? Infinity) <= 20 },
};

/** A filter icon is a tag unless it says otherwise. */
const matchesFilters = (p, filters = state.filters) => filters.every((f) => (LIST_FILTERS[f]?.test ? LIST_FILTERS[f].test(p) : (p.tags || []).includes(f)));

const ICON_FILTERS = () => [...document.querySelectorAll("#icon-filters [data-filter]")].map((b) => b.dataset.filter);

function renderIconFilters() {
  for (const b of document.querySelectorAll("[data-filter]")) b.setAttribute("aria-pressed", String(state.filters.includes(b.dataset.filter)));
  const icons = new Set(ICON_FILTERS());
  const extra = state.filters.filter((f) => !icons.has(f)).length;
  for (const b of document.querySelectorAll("[data-more-filters]")) {
    b.setAttribute("aria-pressed", String(extra > 0));
    b.querySelector(".count").textContent = extra ? ` · ${extra}` : "";
  }
}

/** The occasions without an icon of their own. Each tap adds or removes one, and the sheet stays open. */
function openMoreFilters() {
  const icons = new Set(ICON_FILTERS());
  const options = TAGS.filter((t) => !icons.has(t))
    .map((t) => ({ f: t, icon: TAG_EMOJI[t], name: t[0].toUpperCase() + t.slice(1) }))
    .map((o) => ({ ...o, on: state.filters.includes(o.f), n: visiblePlaces({ filters: [...new Set([...state.filters, o.f])] }).length }))
    .filter((o) => o.on || o.n);
  const shown = visiblePlaces().length;
  openSheet(
    `${sheetHead("More filters", "A place has to match every one you pick, and the icons on the list.")}
    <div class="sheet-body">
      <div class="more-filters">${options
        .map(
          (o) =>
            `<button type="button" class="chip" data-filter="${esc(o.f)}" aria-pressed="${o.on}"><span aria-hidden="true">${o.icon}</span> ${esc(o.name)} <span class="hint num">${o.n}</span></button>`,
        )
        .join("")}</div>
      ${options.length ? "" : `<p class="hint">Nothing here has another occasion tag. Add tags under Edit details on any place.</p>`}
      <div class="btn-row"><button class="btn primary" type="button" data-act="close">Show ${shown} ${shown === 1 ? "place" : "places"}</button>${
        filterLabels().length ? `<button class="btn" type="button" data-clear-all>Clear all</button>` : ""
      }</div>
    </div>`,
    { type: "more" },
  );
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
  if (isArchived(p)) pills.push(`<span class="pill">${esc(archiveLabel(p))}</span>`);
  else if (closedForGood(p)) pills.push(`<span class="pill danger">Closed for good</span>`);
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
  const price = p.price_range ? `${sub ? " · " : ""}<span class="price">${esc(p.price_range)}</span>` : "";
  return `<button type="button" class="place-card${visited ? " visited" : ""}${closedForGood(p) || isArchived(p) ? " gone" : ""}" data-open="${esc(p.id)}">
    ${thumb(p)}
    <div class="main"><div class="title">${esc(p.name)}</div><div class="sub">${esc(sub)}${price}</div>${extras.length ? `<div class="extras">${extras.join("")}</div>` : ""}</div>
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
        ${isOwner() ? `<button class="btn small" type="button" data-debug-share="${esc(s.id)}">Details</button>` : ""}
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
  // Occasions picked under More, or from a place's tags, that have no icon of their own.
  for (const f of state.filters.filter((x) => !LIST_FILTERS[x])) {
    chips.push(`<button type="button" class="chip on" data-filter="${esc(f)}">${TAG_EMOJI[f] || ""} ${esc(f)} <span aria-hidden="true">✕</span></button>`);
  }
  return chips.length ? `<div class="chip-row" aria-label="Active filters">${chips.join("")}</div>` : "";
}

function renderArchived(el, q) {
  const all = state.places.filter(isArchived);
  const items = sortPlaces(all.filter((p) => matchesSearch(p, q)));
  el.innerHTML = `<div class="chip-row"><button type="button" class="chip" data-archived-view="0">← Back to your list</button></div>
    <div class="section-label">Archived · <span class="num">${items.length}</span></div>
    <p class="hint archived-help">These stay off the map and out of your lists. Sharing another reel of one of them won't save it again. Open one to unarchive it.</p>
    ${
      items.length
        ? `<div class="cards">${items.map(placeCard).join("")}</div>`
        : `<div class="empty"><h2>${all.length ? "No matches" : "Nothing archived"}</h2><p>${all.length ? "Try another search." : "Open a place and tap Archive to hide it without deleting it."}</p></div>`
    }`;
}

function renderList() {
  const el = $("#list");
  const q = state.search.trim();
  const icons = $("#icon-filters");
  if (icons) icons.hidden = (state.archivedView && !state.guest) || !state.places.length;
  if (state.archivedView && !state.guest) return renderArchived(el, q);
  let html = activeFilters();
  if (state.shares.length) {
    html += `<div class="section-label">Just shared</div><div class="cards">${state.shares.map(inboxCard).join("")}</div>`;
  }
  const closed = state.places.filter((p) => closedForGood(p) && p.visit_status === "want" && !isArchived(p));
  if (closed.length && !state.guest) {
    html += `<div class="notice"><strong>${closed.length === 1 ? "A place on your list has" : `${closed.length} places on your list have`} closed for good</strong>
      <div class="btn-row">${closed.map((p) => `<button class="btn small" type="button" data-open="${esc(p.id)}">${esc(p.name)}</button>`).join("")}</div>
      <div class="btn-row"><button class="btn small danger" type="button" data-archive-closed>Archive ${closed.length === 1 ? "it" : "them"}</button></div></div>`;
  }
  if (!state.places.length) {
    html += emptyState();
  } else {
    const items = sortPlaces(visiblePlaces().filter((p) => matchesSearch(p, q)));
    const on = filterLabels({ withSearch: true });
    const clear = on.length ? `<button type="button" class="link-btn" data-clear-all>Clear all</button>` : "";
    html += `<div class="section-row"><div class="section-label">${esc([SCOPE_LABEL[state.status], ...on].join(" · "))} · <span class="num">${items.length}</span></div>${clear}</div>`;
    html += items.length
      ? `<div class="cards">${items.map(placeCard).join("")}</div>`
      : on.length
        ? `<div class="empty"><h2>No matches</h2><p>Nothing in ${esc(SCOPE_LABEL[state.status])} matches all of: ${esc(on.join(", "))}.</p><button class="btn" type="button" data-clear-all>Clear all filters</button></div>`
        : `<div class="empty"><h2>No matches</h2><p>Switch between To try, Visited and All.</p></div>`;
  }
  const archived = state.places.filter(isArchived);
  if (archived.length && !state.guest) {
    const hits = q ? archived.filter((p) => matchesSearch(p, q)).length : archived.length;
    html += `<button type="button" class="archived-row" data-archived-view="1">
      <span>Archived</span><span class="hint num">${q ? `${hits} ${hits === 1 ? "match" : "matches"}` : archived.length}</span></button>`;
  }
  el.innerHTML = html;
  renderIconFilters();
}

function emptyState() {
  if (state.guest) return `<div class="empty"><h2>Nothing here yet</h2><p>This shared list is empty.</p></div>`;
  return `<div class="empty">
    <h2>Nothing saved yet</h2>
    <p>When a reel shows a place you want to try, tap Share in Instagram and pick Reel Eats. You can also tap Add and paste the link.</p>
    <button class="btn" type="button" data-go="settings">How to set up sharing</button>
  </div>`;
}

/* ---------- Pick: swipe a short list with whoever's going out ---------- */
const VOTER_KEY = "reel-eats-voter";
const PICK_NAME_KEY = "reel-eats-pick-name";
const PICK_KEY = "reel-eats-pick";
/** Same limit as the server's. */
const MAX_PICK = 40;
const PICK_MODES = {
  relay: {
    name: "Pass it along",
    help: "You swipe first, then send the link on. Each person sees only what's left, and a place anyone drops is gone.",
  },
  vote: {
    name: "Everyone votes",
    help: "Everyone swipes the whole set. Then the places are ranked by how many people kept them.",
  },
};

let memVoter = "";
/** Made on this phone and kept there, so the same person keeps their swipes. */
function voterId() {
  const saved = store.get(VOTER_KEY);
  if (saved && /^[\w-]{8,64}$/.test(saved)) return saved;
  memVoter ||= crypto.randomUUID ? crypto.randomUUID() : `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  store.set(VOTER_KEY, memVoter);
  return memVoter;
}

class PickError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** A pick's link works without the access code, so these calls don't send it. */
async function pickApi(token, action, body) {
  const path = `/api/pick/${enc(token)}${action ? `/${action}` : `?voter=${enc(voterId())}`}`;
  const init = body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voter_id: voterId(), ...body }) } : {};
  const res = await fetch(path, init).catch(() => null);
  if (!res) throw new PickError("Can't reach the server. Check your connection and try again.", 0);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new PickError(data.error || `Something went wrong (${res.status}).`, res.status);
  return data;
}

/** Places for the setup screen: what the filters show, nearest first, minus closed ones. */
function pickPool() {
  return sortPlaces(visiblePlaces().filter((p) => !closedForGood(p)));
}

const pickSwiped = []; // this session's swipes, newest last, for Undo
let pickQueue = Promise.resolve();
let pickInFlight = 0;
let pickPoll;
/** A pick's link this phone was opened with. If that pick has ended, say so. */
let pickLinkOpened = null;

function pickSignature(d) {
  return JSON.stringify([d.left, d.todo, d.ranking, d.people, d.agreed, d.mine, d.joined]);
}

function applyPick(data) {
  const d = { ...data, places: (data.places || []).map(parsePlace) };
  const before = state.pick?.data ? pickSignature(state.pick.data) : "";
  const same = state.pick?.token === d.token;
  state.pick = { ...(same ? state.pick : {}), token: d.token, data: d, ended: null };
  if (!same) pickSwiped.length = 0;
  if (state.guest?.pick) state.places = d.places;
  else store.set(PICK_KEY, d.token);
  return pickSignature(d) !== before;
}

/** status: 410 when the pick is over, 404 when the link never worked. */
function pickEnded(token, status) {
  state.pick = { token, data: null, ended: status === 404 ? 404 : 410 };
  if (!state.guest?.pick) store.set(PICK_KEY, null);
}

/** quiet: picking up where this phone left off, so a pick that has since ended just goes away. */
async function openPick(token, { quiet = false } = {}) {
  try {
    applyPick(await pickApi(token));
  } catch (e) {
    if (quiet && !state.guest) {
      store.set(PICK_KEY, null);
      if (state.pick?.token === token) state.pick = null;
    } else if (e.status === 404 || e.status === 410) pickEnded(token, e.status);
    else toast(e.message);
  }
  if (state.view === "pick") renderPick();
  schedulePickPoll();
}

/** Others swipe too, so the pick on screen is re-read every few seconds. */
function schedulePickPoll() {
  clearTimeout(pickPoll);
  if (state.view !== "pick" || !state.pick?.data || document.visibilityState !== "visible") return;
  pickPoll = setTimeout(refreshPick, 5000);
}

async function refreshPick() {
  const token = state.pick?.token;
  if (!token || !state.pick.data) return;
  if (!pickInFlight) {
    try {
      const data = await pickApi(token);
      const busy = $("#swipe-stack .dragging") || document.activeElement?.closest?.("#pick input");
      if (state.pick?.token === token && !pickInFlight && applyPick(data) && !busy) renderPick();
    } catch (e) {
      if (e.status === 404 || e.status === 410) {
        pickEnded(token, e.status);
        renderPick();
      }
    }
  }
  schedulePickPoll();
}

async function loadPickList() {
  if (state.guest) return;
  try {
    state.picks = (await api("/api/picks")).picks;
  } catch {
    state.picks = [];
  }
  if (state.view === "pick" && !state.pick) renderPick();
}

function timeLeft(expires) {
  const mins = Math.max(0, Math.round((expires - Date.now()) / 60000));
  return mins >= 90 ? `ends in ${Math.round(mins / 60)} h` : `ends in ${mins} min`;
}

function pickThumbs(places, max = 7) {
  const shown = places.slice(0, max);
  const more = places.length - shown.length;
  return `<div class="pick-thumbs" aria-hidden="true">${shown.map((p) => thumb(p, "small")).join("")}${more > 0 ? `<span class="more num">+${more}</span>` : ""}</div>`;
}

function renderPick() {
  const el = $("#pick");
  if (!el) return;
  document.body.classList.toggle("picking", state.view === "pick" && !!state.pick);
  const pick = state.pick;
  if (!pick) return renderPickSetup(el);
  if (pick.ended) {
    const gone = pick.ended === 404;
    const next = state.guest ? "Ask whoever sent it to start a new one." : "Start a new one from your filters.";
    el.innerHTML = `<div class="empty"><h2>${gone ? "This link doesn't work" : "This pick has ended"}</h2>
      <p>${gone ? `It may be missing a letter, or the pick was cleared away. ${next}` : `Picks last a day. ${next}`}</p>${
        state.guest ? "" : `<button class="btn primary" type="button" data-pick="new">Start a new pick</button>`
      }</div>`;
    return;
  }
  const d = pick.data;
  if (!d) {
    el.innerHTML = `<div class="empty"><div class="spinner" aria-hidden="true"></div></div>`;
    return;
  }
  if (!d.joined) return renderPickJoin(el, d);
  if (d.todo.length && !pick.showResults) return renderSwipe(el, d);
  renderPickResults(el, d);
}

function renderPickSetup(el) {
  const pool = pickPool();
  const used = pool.slice(0, MAX_PICK);
  const on = filterLabels();
  // Keep what's typed when a filter redraws the screen.
  const name = $("#pick-name")?.value ?? (store.get(PICK_NAME_KEY) || state.viewer.name || "");
  const mode = state.pickMode;
  const going = (state.picks || [])
    .map(
      (x) => `<button type="button" class="pick-row" data-pick="open" data-token="${esc(x.token)}">
        <span class="main"><span class="title">${esc(x.label || "Where should we go?")}</span>
        <span class="sub">${esc(PICK_MODES[x.mode]?.name || "")} · ${x.places} places · ${esc(x.people.join(", ") || "nobody yet")}</span></span>
        <span class="hint">${esc(timeLeft(x.expires_at))}</span>
      </button>`,
    )
    .join("");
  el.innerHTML = `<div class="pick-setup">
    <div class="pick-hero">
      <h2>Pick a place together</h2>
      <p>Swipe right on places you'd go to and left on the rest. Then send the link to whoever's coming, and they swipe too.</p>
    </div>
    <div class="icon-filters" role="group" aria-label="Filter the places">${$("#icon-filters").innerHTML}</div>
    <div class="section-row"><div class="section-label">${esc([SCOPE_LABEL[state.status], ...on].join(" · "))} · <span class="num">${pool.length}</span></div>${
      on.length ? `<button type="button" class="link-btn" data-clear-all>Clear all</button>` : ""
    }</div>
    ${pool.length ? pickThumbs(used) : ""}
    ${
      pool.length > MAX_PICK
        ? `<p class="hint">A pick takes up to ${MAX_PICK} places, so the ${MAX_PICK} ${state.sort === "home" && state.home ? "nearest home" : "first in the list's order"} are used. Add a filter to narrow it down.</p>`
        : ""
    }
    ${
      pool.length < 2
        ? `<div class="notice">${pool.length ? "Only one place matches." : "Nothing matches."} A pick needs at least two. Clear a filter, or switch between To try, Visited and All.</div>`
        : `<section class="panel pick-start">
      <div class="segmented" role="group" aria-label="How it works">${Object.entries(PICK_MODES)
        .map(([k, m]) => `<button type="button" data-pick-mode="${k}" aria-pressed="${mode === k}">${esc(m.name)}</button>`)
        .join("")}</div>
      <p class="hint">${esc(PICK_MODES[mode].help)}</p>
      <label>Your name
        <input type="text" id="pick-name" maxlength="24" autocomplete="given-name" value="${esc(name)}" placeholder="Shown next to what you keep" />
      </label>
      <button class="btn primary" type="button" data-pick="start">Start swiping ${used.length} places</button>
    </section>`
    }
    ${going ? `<div class="section-label">Picks still going</div><div class="cards">${going}</div>` : ""}
  </div>`;
  renderIconFilters();
}

function renderPickJoin(el, d) {
  const starter = d.people[0]?.name;
  const n = d.mode === "relay" ? d.left.length : d.places.length;
  const how =
    d.mode === "relay"
      ? "Swipe right on the ones you'd go to and left on the rest. Anything you drop is off the list for everyone."
      : "Swipe right on the ones you'd go to and left on the rest. Everyone swipes the same places, and the most kept wins.";
  el.innerHTML = `<div class="pick-join">
    <div class="pick-hero">
      <div class="kicker">${esc(starter ? `${starter} started a pick` : "A pick")} · ${esc(PICK_MODES[d.mode].name)}</div>
      <h2>${esc(d.label || "Where should we go?")}</h2>
      <p>${n} ${n === 1 ? "place" : "places"}${d.mode === "relay" && n < d.places.length ? " left" : ""}. ${esc(how)}</p>
    </div>
    ${pickThumbs(d.places.filter((p) => d.left.includes(p.id)))}
    <form class="pick-start panel" data-pick-form="join">
      <label>Your name
        <input type="text" name="name" maxlength="24" autocomplete="given-name" required value="${esc(store.get(PICK_NAME_KEY) || (state.guest ? "" : state.viewer.name || ""))}" />
      </label>
      <button class="btn primary" type="submit">Start swiping</button>
      <p class="hint">Your name shows next to what you keep. There's nothing to sign up for.</p>
    </form>
  </div>`;
}

function swipeCard(p, top) {
  const src = media(p.photo_key);
  const sub = [p.cuisine || p.category, cityOf(p), p.price_range].filter(Boolean).join(" · ");
  const facts = [];
  if (p.rating) facts.push(`<span>★ ${esc(p.rating.toFixed(1))}${p.rating_count ? ` <span class="dim">(${esc(p.rating_count.toLocaleString())})</span>` : ""}</span>`);
  const h = hoursNow(p);
  if (h) facts.push(`<span class="pill ${h.tone}">${esc(h.text)}</span>`);
  if (goSoonActive(p)) facts.push(`<span class="pill hot">⏳ ${esc(p.go_soon)}</span>`);
  const own = !state.guest && state.places.find((x) => x.id === p.id);
  if (own?.distance_m != null) facts.push(`<span>${esc(fmtDist(own.distance_m))} from home</span>`);
  const dishes = (p.dishes || []).slice(0, 4);
  return `<article class="swipe-card${top ? " top" : ""}" data-card="${esc(p.id)}" ${top ? "" : 'aria-hidden="true"'}>
    ${src ? `<img class="swipe-photo" src="${esc(src)}" alt="" decoding="async" draggable="false" />` : `<div class="swipe-photo glyph-bg" aria-hidden="true">${emoji(p.category)}</div>`}
    <div class="stamp keep" aria-hidden="true">Keep</div>
    <div class="stamp drop" aria-hidden="true">Nope</div>
    <div class="swipe-info">
      <h3>${esc(p.name)}</h3>
      ${sub ? `<div class="sub">${esc(sub)}</div>` : ""}
      ${facts.length ? `<div class="facts">${facts.join("")}</div>` : ""}
      ${p.summary ? `<p class="summary">${esc(p.summary)}</p>` : ""}
      ${dishes.length ? `<div class="dishes">${dishes.map((x) => `<span>${esc(x)}</span>`).join("")}</div>` : ""}
      ${top ? `<button type="button" class="details-btn" data-open="${esc(p.id)}">Details</button>` : ""}
    </div>
  </article>`;
}

function renderSwipe(el, d) {
  const byId = new Map(d.places.map((p) => [p.id, p]));
  const [first, second] = d.todo.map((id) => byId.get(id)).filter(Boolean);
  // Counted from this person's own swipes, so a drop doesn't make it go backwards.
  const done = d.places.filter((p) => p.id in d.mine).length;
  const total = done + d.todo.length;
  el.innerHTML = `<div class="swipe">
    <div class="swipe-top">
      <div><strong>${esc(d.label || "Where should we go?")}</strong> <span class="hint num">${Math.min(done + 1, total)} of ${total}</span></div>
      <button type="button" class="link-btn" data-pick="results">${d.mode === "relay" ? "What's left" : "Results"}</button>
    </div>
    <div class="swipe-stack" id="swipe-stack">${second ? swipeCard(second, false) : ""}${first ? swipeCard(first, true) : ""}</div>
    <div class="swipe-actions">
      <button type="button" class="swipe-btn drop" data-pick="drop" aria-label="Not this one"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      <button type="button" class="swipe-btn undo" data-pick="undo" aria-label="Undo" ${pickSwiped.length ? "" : "disabled"}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/></svg></button>
      <button type="button" class="swipe-btn keep" data-pick="keep" aria-label="Keep it"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 20.5s-8-4.9-8-10.9A4.6 4.6 0 0112 6.7a4.6 4.6 0 018 2.9c0 6-8 10.9-8 10.9z"/></svg></button>
    </div>
  </div>`;
  bindSwipe();
}

/** Drag the top card left or right. A short flick counts too. */
function bindSwipe() {
  const card = $("#swipe-stack .swipe-card.top");
  if (!card) return;
  let start = null;
  let dx = 0;
  let dy = 0;
  const reset = () => {
    card.style.transform = "";
    card.style.setProperty("--keep", 0);
    card.style.setProperty("--drop", 0);
  };
  card.addEventListener("pointerdown", (e) => {
    if (e.button > 0 || e.target.closest("button, a")) return;
    start = { x: e.clientX, y: e.clientY, t: performance.now() };
    dx = dy = 0;
    card.setPointerCapture(e.pointerId);
    card.classList.add("dragging");
  });
  card.addEventListener("pointermove", (e) => {
    if (!start) return;
    dx = e.clientX - start.x;
    dy = e.clientY - start.y;
    card.style.transform = `translate(${dx}px, ${dy * 0.25}px) rotate(${dx / 20}deg)`;
    card.style.setProperty("--keep", Math.max(0, Math.min(1, dx / 90)));
    card.style.setProperty("--drop", Math.max(0, Math.min(1, -dx / 90)));
  });
  const end = (e) => {
    if (!start) return;
    const fast = Math.abs(dx) / Math.max(1, performance.now() - start.t) > 0.5;
    const tap = e.type === "pointerup" && Math.abs(dx) < 6 && Math.abs(dy) < 6;
    start = null;
    card.classList.remove("dragging");
    if (Math.abs(dx) > 100 || (fast && Math.abs(dx) > 40)) return swipe(dx > 0);
    reset();
    if (tap) openPlace(card.dataset.card);
  };
  card.addEventListener("pointerup", end);
  card.addEventListener("pointercancel", end);
}

function swipe(keep) {
  const d = state.pick?.data;
  const id = d?.todo[0];
  if (!id) return;
  d.todo = d.todo.slice(1);
  d.mine = { ...d.mine, [id]: keep };
  if (!keep && d.mode === "relay") d.left = d.left.filter((x) => x !== id);
  pickSwiped.push(id);
  const card = $("#swipe-stack .swipe-card.top");
  if (card && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    card.classList.add(keep ? "fly-keep" : "fly-drop");
    setTimeout(renderPick, 200);
  } else renderPick();
  sendVote(id, keep);
}

function undoSwipe() {
  const d = state.pick?.data;
  const id = pickSwiped.pop();
  if (!d || !id) return;
  delete d.mine[id];
  d.todo = [id, ...d.todo.filter((x) => x !== id)];
  if (!d.left.includes(id)) d.left = d.places.map((p) => p.id).filter((x) => x === id || d.left.includes(x));
  state.pick.showResults = false;
  renderPick();
  sendVote(id, null);
}

/** Swipes go to the server one at a time, in order. The screen follows the server once they're all in. */
function sendVote(placeId, keep) {
  const token = state.pick.token;
  pickInFlight++;
  pickQueue = pickQueue
    .then(() => pickApi(token, "vote", { place_id: placeId, keep }))
    .then(
      (data) => {
        pickInFlight--;
        if (pickInFlight || state.pick?.token !== token) return;
        const localTop = state.pick.data.todo[0];
        const changed = applyPick(data);
        const onSwipe = !!$("#swipe-stack");
        if (changed && (!onSwipe || data.todo[0] !== localTop || !data.todo.length) && !$("#swipe-stack .dragging")) renderPick();
      },
      (e) => {
        pickInFlight--;
        toast(e.message);
        if (e.status === 404 || e.status === 410) {
          pickEnded(token, e.status);
          renderPick();
        } else refreshPick();
      },
    );
}

async function vote(placeId, keep) {
  const d = state.pick?.data;
  if (!d) return;
  d.mine = { ...d.mine, [placeId]: keep };
  sendVote(placeId, keep);
}

function matchHero(p, kicker, again = false) {
  const book = bookingLinks(p)[0];
  const menu = menuFor(p);
  return `<section class="match">
    <div class="kicker">${kicker}</div>
    <button type="button" class="match-card" data-open="${esc(p.id)}">
      ${media(p.photo_key) ? `<img src="${esc(media(p.photo_key))}" alt="" decoding="async" />` : `<span class="glyph-bg" aria-hidden="true">${emoji(p.category)}</span>`}
      <span class="match-name">${esc(p.name)}</span>
      <span class="match-sub">${esc([p.cuisine || p.category, cityOf(p), p.price_range].filter(Boolean).join(" · "))}</span>
    </button>
    <div class="btn-row">
      ${p.located ? `<a class="btn primary" href="${esc(mapsLink(p))}" target="_blank" rel="noopener">Directions</a>` : ""}
      ${book ? `<a class="btn" href="${esc(book.href)}" target="_blank" rel="noopener">${esc(book.label === "Reserve a table" ? "Book" : `Book on ${book.label}`)}</a>` : ""}
      ${menu ? `<a class="btn" href="${esc(menu)}" target="_blank" rel="noopener">Menu</a>` : ""}
      ${again ? `<button class="btn" type="button" data-pick="random">Pick again</button>` : ""}
    </div>
  </section>`;
}

function pickItem(p, r, d) {
  const mine = d.mine[p.id];
  const tally = r
    ? `<span class="tally-line">${r.kept_by.length ? `♥ ${esc(r.kept_by.join(", "))}` : ""}${r.kept_by.length && r.dropped_by.length ? " · " : ""}${
        r.dropped_by.length ? `✕ ${esc(r.dropped_by.join(", "))}` : ""
      }</span>`
    : "";
  const everyone = d.agreed.includes(p.id) ? ` <span class="pill visited">Everyone ♥</span>` : "";
  return `<div class="pick-item">
    <button type="button" class="pick-open" data-open="${esc(p.id)}">
      ${thumb(p)}
      <span class="main"><span class="title">${esc(p.name)}${everyone}</span><span class="sub">${esc([p.cuisine || p.category, cityOf(p), p.price_range].filter(Boolean).join(" · "))}</span>${tally}</span>
    </button>
    <div class="pick-vote">
      <button type="button" class="mini-vote drop" data-pick="vote" data-id="${esc(p.id)}" data-keep="0" aria-pressed="${mine === false}" aria-label="Drop ${esc(p.name)}">✕</button>
      <button type="button" class="mini-vote keep" data-pick="vote" data-id="${esc(p.id)}" data-keep="1" aria-pressed="${mine === true}" aria-label="Keep ${esc(p.name)}">♥</button>
    </div>
  </div>`;
}

/** Where "Pick one for us" chooses from: what everyone kept, or else the most kept. */
function pickCandidates(d) {
  if (d.agreed.length) return d.agreed;
  if (d.mode === "relay") return d.left;
  const top = d.ranking[0]?.kept_by.length || 0;
  return top ? d.ranking.filter((r) => r.kept_by.length === top).map((r) => r.place_id) : [];
}

function renderPickResults(el, d) {
  const byId = new Map(d.places.map((p) => [p.id, p]));
  const rank = new Map(d.ranking.map((r) => [r.place_id, r]));
  const alone = d.people.length < 2;
  const waiting = d.people.filter((p) => !p.done && !p.me);
  const mineLeft = d.todo.length;
  const chosen = state.pick.chosen && byId.get(state.pick.chosen);
  const candidates = pickCandidates(d);
  let hero = "";
  let head = "";
  let matched = false;
  if (chosen) hero = matchHero(chosen, "🎲 Picked for you", candidates.length > 1);
  else if (d.mode === "relay" && !d.left.length) {
    head = `<div class="empty"><h2>Nothing left</h2><p>Every place was dropped by someone.</p></div>`;
  } else if (d.agreed.length === 1 && d.all_done) {
    hero = matchHero(byId.get(d.agreed[0]), "🎉 It's a match");
    matched = true;
  }
  else if (d.all_done && !alone) {
    head =
      d.agreed.length > 1
        ? `<div class="pick-hero"><h2>Everyone's happy with ${d.agreed.length} places</h2><p>Pick one, or let the app choose.</p></div>`
        : `<div class="pick-hero"><h2>No place everyone kept</h2><p>${candidates.length ? "The most kept are at the top." : "Nobody kept anything."}</p></div>`;
  } else {
    const n = d.mode === "relay" ? d.left.length : d.places.length;
    const status = alone
      ? d.mode === "relay"
        ? `Send the link to whoever's coming. They'll see only ${n === 1 ? "this one" : `these ${n}`}.`
        : "Send the link to whoever's coming. Everyone swipes the same places."
      : waiting.length
        ? `Waiting on ${waiting.map((p) => `${p.name} (${p.todo} to go)`).join(", ")}.`
        : d.people.some((p) => !p.done)
          ? "You still have cards to swipe."
          : "";
    head = `<div class="pick-hero"><h2>${d.mode === "relay" ? `${n} ${n === 1 ? "place" : "places"} left` : "So far"}</h2>${status ? `<p>${esc(status)}</p>` : ""}</div>`;
  }
  const people = `<div class="chip-row pick-people">${d.people
    .map((p) => `<span class="chip${p.done ? " on" : ""}">${esc(p.me ? `${p.name} (you)` : p.name)}${p.done ? " ✓" : ` · ${p.todo} to go`}</span>`)
    .join("")}</div>`;
  const actions = `<div class="btn-row">
    <button class="btn${alone || waiting.length ? " primary" : ""}" type="button" data-pick="share">Send the link</button>
    ${mineLeft ? `<button class="btn" type="button" data-pick="swipe">Keep swiping (${mineLeft})</button>` : ""}
    ${candidates.length > 1 && !chosen ? `<button class="btn" type="button" data-pick="random">Pick one for us</button>` : ""}
  </div>`;
  // A match in Pass it along is the only place left, and it's already at the top.
  const listed = d.mode === "relay" ? (matched ? [] : d.left) : d.ranking.map((r) => r.place_id);
  const list = listed.map((id) => byId.get(id) && pickItem(byId.get(id), rank.get(id), d)).filter(Boolean).join("");
  const dropped = d.mode === "relay" ? d.places.filter((p) => !d.left.includes(p.id)) : [];
  el.innerHTML = `<div class="pick-results">
    ${hero}${head}${people}${actions}
    ${list ? `<div class="section-label">${d.mode === "relay" ? "Still in" : "Most kept first"}</div><div class="cards pick-list">${list}</div>` : ""}
    ${
      dropped.length
        ? `<details class="pick-dropped"><summary>Dropped · <span class="num">${dropped.length}</span></summary><div class="cards pick-list">${dropped
            .map((p) => pickItem(p, rank.get(p.id), d))
            .join("")}</div></details>`
        : ""
    }
    <div class="pick-foot">
      <span class="hint">${esc(PICK_MODES[d.mode].name)} · ${esc(timeLeft(d.expires_at))}</span>
      ${state.guest ? "" : `<button class="link-btn" type="button" data-pick="new">New pick</button><button class="link-btn danger" type="button" data-pick="end">End this pick</button>`}
    </div>
  </div>`;
}

async function startPick() {
  const used = pickPool().slice(0, MAX_PICK);
  const box = $("#pick-name");
  const name = box.value.trim();
  if (!name) {
    toast("Type your name first, so the others know who kept what.");
    return box.focus();
  }
  store.set(PICK_NAME_KEY, name);
  const btn = $('[data-pick="start"]');
  btn.disabled = true;
  try {
    const data = await api("/api/picks", {
      method: "POST",
      body: { mode: state.pickMode, place_ids: used.map((p) => p.id), label: filterLabels().join(" · "), name, voter_id: voterId() },
    });
    state.pick = null;
    applyPick(data);
    state.picks = null;
    renderPick();
    schedulePickPoll();
  } catch (e) {
    if (!(e instanceof Unauthorized)) toast(e.message);
    btn.disabled = false;
  }
}

function sharePick() {
  const d = state.pick?.data;
  if (!d) return;
  const n = d.mode === "relay" ? d.left.length : d.places.length;
  const text =
    d.mode === "relay"
      ? `Help pick a place: ${n} left${d.label ? ` (${d.label})` : ""}. Swipe right on the ones you'd go to.`
      : `Help pick a place${d.label ? ` (${d.label})` : ""}. Swipe right on the ones you'd go to.`;
  shareLink(`${location.origin}/p/${d.token}`, "Pick a place", text);
}

async function pickAction(t) {
  const act = t.dataset.pick;
  if (act === "start") return startPick();
  if (act === "open") return openPick(t.dataset.token);
  if (act === "keep" || act === "drop") return swipe(act === "keep");
  if (act === "undo") return undoSwipe();
  if (act === "share") return sharePick();
  if (act === "results" || act === "swipe") {
    state.pick.showResults = act === "results";
    return renderPick();
  }
  if (act === "vote") return vote(t.dataset.id, t.dataset.keep === "1");
  if (act === "random") {
    const from = pickCandidates(state.pick.data).filter((id) => id !== state.pick.chosen);
    state.pick.chosen = from[Math.floor(Math.random() * from.length)] || state.pick.chosen;
    renderPick();
    return $("#view-pick").scrollTo({ top: 0, behavior: "smooth" });
  }
  if (act === "new") {
    state.pick = null;
    store.set(PICK_KEY, null);
    renderPick();
    return loadPickList();
  }
  if (act === "end") {
    if (!confirmTwice(t, "Tap again to end it for everyone")) return;
    await api(`/api/picks/${enc(state.pick.token)}`, { method: "DELETE" }).catch(() => {});
    state.pick = null;
    store.set(PICK_KEY, null);
    toast("Pick ended. Its link doesn't work anymore.");
    renderPick();
    return loadPickList();
  }
}

async function joinPickAs(name) {
  store.set(PICK_NAME_KEY, name);
  try {
    applyPick(await pickApi(state.pick.token, "join", { name }));
    renderPick();
  } catch (e) {
    toast(e.message);
  }
}

/* ---------- settings ---------- */
function appearancePanel() {
  const t = themePrefs();
  const dark = t.mode === "dark" || (t.mode === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  const mode = (m, label) => `<button type="button" data-theme-mode="${m}" aria-pressed="${t.mode === m}">${label}</button>`;
  return `<section class="panel">
      <h2>Appearance</h2>
      <p class="hint">Saved on this phone only.</p>
      <div class="segmented" role="group" aria-label="Light or dark">${mode("auto", "Match phone")}${mode("light", "Light")}${mode("dark", "Dark")}</div>
      <div class="swatches" role="group" aria-label="Color">${THEMES.map(
        (x) => `<button type="button" class="swatch" data-theme-accent="${x.id}" aria-pressed="${t.accent === x.id}"><span class="dot" style="background:${dark ? x.darkAccent : x.accent}"></span>${esc(x.name)}</button>`,
      ).join("")}</div>
    </section>`;
}

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

    ${appearancePanel()}

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
  const list = state.places.filter((p) => !isArchived(p));
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
  if (kind === "kml") return download("reel-eats.kml", toKml(state.places.filter((p) => !isArchived(p))), "application/vnd.google-earth.kml+xml");
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
    branch_kept: p.keep_branch ? "yes" : "",
    other_locations: (p.branches || [])
      .filter((b) => b.id !== p.google_place_id)
      .map((b) => b.address)
      .join("; "),
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
    archived: p.archived_at ? new Date(p.archived_at).toISOString() : "",
    archive_reason: ARCHIVE_REASONS[p.archive_reason] || "",
    saved: new Date(p.created_at).toISOString(),
  }));
  if (kind === "json") {
    // JSON gets every location in full, not just the addresses.
    const full = rows.map((r, i) => ({
      ...r,
      other_locations: (state.places[i].branches || [])
        .filter((x) => x.id !== state.places[i].google_place_id)
        .map((x) => ({ name: x.name, address: x.address, lat: x.lat, lng: x.lng, google_maps: x.mapsUrl, phone: x.phone, website: x.website })),
    }));
    return download("reel-eats.json", JSON.stringify(full, null, 2), "application/json");
  }
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

function sheetHead(title, kicker, buttons = "") {
  return `<div class="sheet-head">
    <div><h2 id="sheet-title">${esc(title)}</h2>${kicker ? `<div class="kicker">${kicker}</div>` : ""}</div>
    <div class="sheet-actions">${buttons}
      <button class="round-btn sheet-close" type="button" data-act="close" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
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
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h9l3 3v15H6z"/><path d="M9 9h6M9 13h6M9 17h4"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>',
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
  const maps = mapsLink(p);
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
    const branches =
      p.branch_count > 1 ? `${guest ? "One" : p.keep_branch ? "Kept this branch, one" : "Closest"} of ${p.branch_count} locations found` : "";
    facts.push(
      `<div class="fact">${ICON.pin}<div>${esc(p.address)}<div class="muted">${esc([dist, branches].filter(Boolean).join(" · "))}</div></div></div>`,
    );
  }
  if (!closedForGood(p)) facts.push(hoursFact(p));
  if (p.rating) {
    facts.push(
      `<div class="fact">${ICON.star}<div>${p.rating.toFixed(1)} on Google <span class="muted num">(${(p.rating_count || 0).toLocaleString()} reviews)</span>${p.price_level ? ` · ${esc(p.price_level)}` : ""}${
        p.price_range ? ` · <strong class="num">${esc(p.price_range)} per person</strong>` : ""
      }</div></div>`,
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
      ? `<details class="more"><summary>All ${branches.length} locations</summary>${
          p.keep_branch
            ? `<div class="kept-note"><span class="hint">This branch stays put when you move, because it's where the reel's pop-up or event is, or you picked it.</span>
                <button class="btn small" type="button" data-act="nearest-branch">Use the closest branch</button></div>`
            : `<p class="hint">Pick one to keep it, even after you move.</p>`
        }<div class="branch-list">${branches
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
        ${isArchived(p) ? "" : `<button class="btn" type="button" data-act="archive-open" aria-expanded="false" aria-controls="archive-reasons">Archive</button>`}
      </div>
      <div class="archive-reasons" id="archive-reasons" hidden>
        <div class="hint">Archiving hides it from the map and your lists, and keeps it from being saved again. Why? This part's optional.</div>
        <div class="btn-row">${Object.entries(ARCHIVE_REASONS)
          .map(([key, label]) => `<button class="btn small${key === "closed" && closedForGood(p) ? " primary" : ""}" type="button" data-act="archive" data-reason="${key}">${esc(label)}</button>`)
          .join("")}</div>
      </div>
      ${visited ? `<div class="stars" role="group" aria-label="Your rating">${stars}</div>` : ""}
      <label>Your notes
        <textarea id="place-notes" placeholder="What to order, when to go, who to bring">${esc(p.notes || "")}</textarea>
      </label>
    </div>

    <details class="more" id="look-again">
      <summary>Look again</summary>
      <form class="stack" data-act-form="look-again">
        <p class="hint">Something off? Say what, and the reel is read again, with the menu page when there is one. Nothing changes until you pick what to apply.</p>
        <label>What's off? <span class="hint">Optional</span>
          <textarea id="look-note" maxlength="500" rows="2" placeholder="It's a cocktail bar · wrong branch, it's the Midtown one · the pop-up ends Nov 1"></textarea>
        </label>
        <label class="check-row"><input type="checkbox" id="look-wrong" /> <span>Wrong place or branch</span></label>
        <div class="btn-row"><button class="btn primary" type="submit" id="look-go">Look again</button></div>
        <div id="look-results" aria-live="polite"></div>
      </form>
    </details>

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

    <details class="more" id="edit-details">
      <summary>Edit details</summary>
      <form class="stack" data-act-form="edit">
        <label>Name <input type="text" id="edit-name" value="${esc(p.name)}" /></label>
        <label>Category
          <select class="field" id="edit-category">${CATEGORIES.map((c) => `<option ${c === p.category ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
        </label>
        <label>Cuisine <input type="text" id="edit-cuisine" value="${esc(p.cuisine || "")}" /></label>
        <label>Summary <textarea id="edit-summary" maxlength="300" rows="2">${esc(p.summary || "")}</textarea></label>
        <label>Dishes <input type="text" id="edit-dishes" placeholder="Commas between them: birria tacos, consomé" value="${esc((p.dishes || []).join(", "))}" /></label>
        <label>Instagram account <input type="text" id="edit-instagram" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="@restaurant" value="${esc(p.instagram_handle ? `@${p.instagram_handle}` : "")}" /></label>
        <label>Menu link <input type="url" id="edit-menu" inputmode="url" autocapitalize="off" spellcheck="false" placeholder="https://… (empty for none)" value="${esc(menuFor(p))}" data-was="${esc(menuFor(p))}" />
          <span class="hint">${
            p.menu_by_hand
              ? "Set by hand, so the app won't change it."
              : menuFor(p)
                ? "Found on the restaurant's website. Change it if it's wrong, or clear it if there isn't one."
                : "None found on the restaurant's website. Paste one if you know it."
          }</span>
        </label>
        <label>Go soon <input type="text" id="edit-go-soon" maxlength="80" placeholder="New opening, pop-up through Oct 12" value="${esc(p.go_soon || "")}" /></label>
        <fieldset class="tag-editor"><legend>Good for</legend>${tagEditor}</fieldset>
        <div class="btn-row"><button class="btn primary" type="submit">Save changes</button></div>
      </form>
    </details>`;

  const editBtn = guest ? "" : `<button class="round-btn" type="button" data-act="edit-open" aria-label="Edit details">${ICON.pencil}</button>`;
  const html = `${sheetHead(p.name, kicker, editBtn)}
  <div class="sheet-body">
    ${
      isArchived(p) && !guest
        ? `<div class="archived-banner"><div><strong>${esc(archiveLabel(p))}</strong><div class="hint">Hidden from the map and your lists since ${esc(fmtDate(p.archived_at))}.</div></div>
            <button class="btn small" type="button" data-act="unarchive">Unarchive</button></div>`
        : ""
    }
    ${reelStrip(p)}
    <div class="btn-row">
      <a class="btn primary" href="${esc(maps)}" target="_blank" rel="noopener">Google Maps</a>
      <a class="btn" href="${esc(apple)}" target="_blank" rel="noopener">Apple Maps</a>
      ${ig ? `<a class="btn" href="${esc(ig)}" target="_blank" rel="noopener">@${esc(p.instagram_handle)}</a>` : ""}
      ${site ? `<a class="btn" href="${esc(site)}" target="_blank" rel="noopener">Website</a>` : ""}
      ${menuButton(p)}
      ${p.located && !isArchived(p) ? `<button class="btn" type="button" data-act="show-on-map">Show on map</button>` : ""}
    </div>

    ${
      p.located || guest
        ? ""
        : `<div class="panel"><h2>Location not found yet</h2><p>Search Google Maps below and pick the right place.</p></div>`
    }
    ${tagPills.length ? `<div class="tag-row">${tagPills.join("")}</div>` : ""}
    ${p.summary ? `<p class="summary">${esc(p.summary)}</p>` : ""}
    ${p.dishes?.length ? `<div class="dishes">${p.dishes.map((d) => `<span class="dish">${esc(d)}</span>`).join("")}</div>` : ""}
    <section class="review-summary" id="review-summary" aria-labelledby="review-summary-title" hidden></section>
    ${facts.filter(Boolean).length ? `<div class="facts">${facts.join("")}</div>` : ""}
    <div class="google-lists" id="google-lists" hidden></div>
    ${bookRow}

    ${mine}

    ${caption}

    ${isOwner() ? `<details class="more" data-debug-place="${esc(p.id)}"><summary>Debugging details</summary><div class="debug-box">Loading…</div></details>` : ""}

    ${guest ? "" : `<div class="btn-row"><button class="btn danger" type="button" data-act="delete">Delete from list</button></div>`}
  </div>`;
  openSheet(html, { type: "place", id });
  if (prevScroll) $("#sheet .sheet-body").scrollTop = prevScroll;
  if (p.located && !guest) loadGoogleExtras(id);
}

/* ---------- Look again ---------- */
let lookResult = null;

const LOOK_LABELS = {
  category: "Category",
  cuisine: "Cuisine",
  summary: "Summary",
  dishes: "Dishes",
  tags_add: "Add tags",
  tags_remove: "Remove tags",
  go_soon: "Go soon",
  instagram_handle: "Instagram",
};

function describeSuggestion(s) {
  if (s.field === "dishes" || s.field === "tags_add" || s.field === "tags_remove") return s.to.join(", ");
  if (s.field === "instagram_handle") return `@${s.to}`;
  if (s.field === "summary") return `“${s.to}”`;
  const to = s.to || "none";
  return s.from ? `${s.from} → ${to}` : to;
}

async function runLookAgain(p) {
  const out = $("#look-results");
  const btn = $("#look-go");
  const wrong = $("#look-wrong").checked;
  btn.disabled = true;
  btn.textContent = "Looking…";
  out.innerHTML = `<p class="hint">Reading the reel again${wrong ? " and searching Google Maps" : ""}. This takes a few seconds.</p>`;
  try {
    const data = await api(`/api/places/${p.id}/look-again`, { method: "POST", body: { note: $("#look-note").value, wrong_place: wrong } });
    lookResult = { id: p.id, data };
    const changes = data.suggestions.map(
      (s, i) => `<label class="check-row"><input type="checkbox" name="look-apply" value="${i}" checked /> <span><strong>${esc(LOOK_LABELS[s.field] || s.field)}:</strong> ${esc(describeSuggestion(s))}</span></label>`,
    );
    const others = data.candidates.filter((c) => c.id !== p.google_place_id);
    const places = wrong
      ? `<fieldset class="suggestions"><legend>Right place?</legend>
          <label class="check-row"><input type="radio" name="look-place" value="" ${others.length ? "" : "checked"} /> <span>Keep ${esc(p.name)}${p.address ? `<span class="hint"> · ${esc(p.address)}</span>` : ""}</span></label>
          ${others
            .map(
              (c, i) => `<label class="check-row"><input type="radio" name="look-place" value="${esc(c.id)}" ${i === 0 ? "checked" : ""} /> <span><strong>${esc(c.name)}</strong><span class="hint"> · ${esc(c.address)}${c.distanceM != null && !state.guest ? ` · ${esc(fmtDist(c.distanceM))}` : ""}</span></span></label>`,
            )
            .join("")}
          ${others.length ? "" : `<p class="hint">Google Maps had nothing else for “${esc(data.query)}”. Try saying the name and neighborhood above.</p>`}
        </fieldset>`
      : "";
    const any = changes.length || others.length;
    out.innerHTML = `<div class="look-results">
        ${changes.length ? `<fieldset class="suggestions"><legend>Suggested changes</legend>${changes.join("")}</fieldset>` : ""}
        ${places}
        ${any ? `<div class="btn-row"><button class="btn primary" type="button" data-act="look-apply">Apply</button></div>` : `<p>Nothing to change. Saying what's off above helps.</p>`}
      </div>`;
  } catch (e) {
    out.innerHTML = e instanceof Unauthorized ? "" : `<p class="hint">${esc(e.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Look again";
  }
}

async function applyLookAgain(p) {
  if (!lookResult || lookResult.id !== p.id) return;
  const picked = [...document.querySelectorAll('input[name="look-apply"]:checked')].map((x) => lookResult.data.suggestions[Number(x.value)]);
  const placeId = document.querySelector('input[name="look-place"]:checked')?.value || "";
  const body = {};
  for (const s of picked) if (!s.field.startsWith("tags_")) body[s.field] = s.to;
  const add = picked.filter((s) => s.field === "tags_add").flatMap((s) => s.to);
  const remove = picked.filter((s) => s.field === "tags_remove").flatMap((s) => s.to);
  if (add.length || remove.length) body.tags = [...(p.tags || []).filter((t) => !remove.includes(t)), ...add];
  try {
    // The place first: switching places replaces its name, address and branches.
    if (placeId && placeId !== p.google_place_id) await api(`/api/places/${p.id}/select`, { method: "POST", body: { place_id: placeId, rename: true } });
    if (Object.keys(body).length) await api(`/api/places/${p.id}`, { method: "PATCH", body });
    lookResult = null;
    googleExtras.delete(p.id);
    await refresh({ rerenderSheet: true });
    toast(picked.length || placeId ? "Updated." : "Nothing picked.");
  } catch (e) {
    if (!(e instanceof Unauthorized)) toast(e.message);
  }
}

/* ---------- Google's review summary, features and menu link ---------- */
/** Fetched when a place is opened, once per visit to the app. Google's terms don't allow storing them. */
const googleExtras = new Map();

function mapsLink(p) {
  return safeUrl(p.maps_url) || `https://www.google.com/maps/search/?api=1&query=${enc([p.name, p.address || p.city_hint].filter(Boolean).join(" "))}`;
}

/** The menu link to show: set by hand, or found on the website the place has now. */
function menuFor(p) {
  return p.menu_url && (state.guest || p.menu_by_hand || p.menu_checked_for === p.website) ? safeUrl(p.menu_url) : "";
}

function menuButton(p) {
  const menu = menuFor(p);
  if (menu) return `<a class="btn" id="menu-btn" href="${esc(menu)}" target="_blank" rel="noopener">${ICON.menu}Menu</a>`;
  // Google's API doesn't hand out the menu photos people post, but the Maps app shows them.
  if (p.located) return `<a class="btn" id="menu-btn" href="${esc(mapsLink(p))}" target="_blank" rel="noopener">${ICON.menu}Menu on Google Maps</a>`;
  return "";
}

async function loadGoogleExtras(id) {
  let data = googleExtras.get(id);
  if (!data) {
    try {
      data = await api(`/api/places/${id}/google`);
    } catch {
      return;
    }
    googleExtras.set(id, data);
  }
  const p = state.places.find((x) => x.id === id);
  if (!p) return;
  if ("menu_url" in data) {
    p.menu_url = data.menu_url;
    p.menu_checked_for = data.menu_checked_for;
    p.menu_by_hand = data.menu_by_hand;
    const box = $("#edit-menu");
    if (box && box.value === box.dataset.was) box.value = box.dataset.was = menuFor(p);
  }
  if (state.sheet?.type === "place" && state.sheet.id === id) showGoogleExtras(p, data);
}

function showGoogleExtras(p, data) {
  const btn = $("#menu-btn");
  if (btn) btn.outerHTML = menuButton(p);
  const box = $("#review-summary");
  const s = data.summary;
  if (box && s?.text) {
    const links = [
      safeUrl(s.reviewsUri) ? `<a href="${esc(safeUrl(s.reviewsUri))}" target="_blank" rel="noopener">See reviews</a>` : "",
      `<a href="https://support.google.com/local-listings/answer/9851099" target="_blank" rel="noopener">About this summary</a>`,
      safeUrl(s.flagUri) ? `<a href="${esc(safeUrl(s.flagUri))}" target="_blank" rel="noopener">Report summary</a>` : "",
    ].filter(Boolean);
    box.innerHTML = `<h3 id="review-summary-title">Review summary</h3>
      <p>${esc(s.text)}</p>
      <div class="disclosure">${esc(s.disclosure)}</div>
      <div class="summary-links">${links.join("")}</div>`;
    box.hidden = false;
  }
  const list = $("#google-lists");
  if (list && data.features?.length) {
    list.innerHTML = `<div class="label">Google lists</div><div class="feature-row">${data.features.map((f) => `<span class="feature">${esc(f)}</span>`).join("")}</div>`;
    list.hidden = false;
  }
}

/* ---------- debugging details ---------- */
const secs = (ms) => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
const dur = (ms) => (ms < 1000 ? `${ms} ms` : secs(ms));
const when = (ts) => new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
let lastDebug = null;

function renderDebug(shares) {
  if (!shares.length) return `<p class="hint">Nothing logged for this place.</p>`;
  const html = shares
    .map((s) => {
      const attempts = [...(s.attempts || [])].reverse();
      const what = s.source_url ? s.source_url.replace(/^https:\/\/(www\.)?/, "") : s.note ? `Typed: ${s.note}` : "Shared text";
      const stored = s.stored.raw_post
        ? `Stored: post ${Math.max(1, Math.round(s.stored.raw_post / 1024))} KB, transcript ${s.stored.transcript ? `${s.stored.transcript} characters` : s.stored.raw_transcript ? "none (no speech)" : "none"}`
        : "";
      const head = `<div class="debug-head"><strong>${esc(what)}</strong>
        <span class="hint">${esc(s.status)} · ${s.attempts_count} ${s.attempts_count === 1 ? "attempt" : "attempts"} · shared ${esc(when(s.created_at))}</span>
        ${stored ? `<span class="hint">${esc(stored)}</span>` : ""}
        ${s.error ? `<span class="error-text">${esc(s.error)}</span>` : ""}</div>`;
      const list = attempts.length
        ? attempts
            .map(
              (a, i) => `<details class="attempt"${i === 0 ? " open" : ""}><summary><span class="outcome ${esc(a.outcome.replace(/\s+/g, "-"))}">${esc(a.outcome)}</span>
                ${esc(when(a.started))} · ${esc(a.trigger)} · ${esc(secs(a.ms))}</summary>
                ${a.error ? `<div class="error-text">${esc(a.error)}</div>` : ""}
                <ol class="steps">${a.steps
                  .map(
                    (st) => `<li class="${st.ok ? "" : "bad"}"><span class="t num">+${esc(secs(st.at))}</span><span class="name">${esc(st.step)}</span>${
                      st.ms ? `<span class="ms num">${esc(dur(st.ms))}</span>` : ""
                    }${st.detail ? `<div class="d">${esc(st.detail)}</div>` : ""}${st.error ? `<div class="d error-text">${esc(st.error)}</div>` : ""}</li>`,
                  )
                  .join("")}</ol></details>`,
            )
            .join("")
        : `<p class="hint">No attempts logged. This reel was saved before the log existed.</p>`;
      return `<div class="debug-share">${head}${list}</div>`;
    })
    .join("");
  return `${html}<div class="btn-row"><button class="btn small" type="button" data-copy-debug>Copy log</button></div>`;
}

async function loadDebug(box, path) {
  try {
    const { shares } = await api(path);
    lastDebug = shares;
    box.innerHTML = renderDebug(shares);
  } catch (e) {
    if (!(e instanceof Unauthorized)) box.innerHTML = `<p class="error-text">${esc(e.message)}</p>`;
  }
}

function openShareDebug(id) {
  resultSheet("Debugging details", `<div class="debug-box">Loading…</div>`, { type: "debug" });
  loadDebug($("#sheet .debug-box"), `/api/shares/${enc(id)}/debug`);
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
    if (fromShareMenu.has(payload)) rememberShared(payload);
  } catch (e) {
    if (e instanceof Unauthorized) return;
    // The server turned it down, so sending it again won't help. A lost connection is tried again.
    if (fromShareMenu.has(payload) && e.status >= 400 && e.status < 500) rememberShared(payload);
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
const SHARED_KEY = "reel-eats-shared";
/** Shares from the share menu, remembered once the server has them. */
const fromShareMenu = new WeakSet();
const shareKey = (d) => [d.url, d.text, d.title].join("\n").slice(0, 600);

function sharesSent() {
  try {
    const list = JSON.parse(store.get(SHARED_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function rememberShared(d) {
  const key = shareKey(d);
  store.set(SHARED_KEY, JSON.stringify([key, ...sharesSent().filter((k) => k !== key)].slice(0, 40)));
}

/**
 * Android hands the app the same share again when it's reopened from recent apps, so a share
 * that already reached the server is skipped. Sharing the reel again from Instagram still works:
 * each share from there carries a new tracking code in the link.
 */
function readShareParams() {
  if (location.pathname !== "/share") return null;
  const q = new URLSearchParams(location.search);
  const data = { url: q.get("url") || "", text: q.get("text") || "", title: q.get("title") || "" };
  history.replaceState(null, "", "/");
  if (!(data.url || data.text || data.title) || sharesSent().includes(shareKey(data))) return null;
  fromShareMenu.add(data);
  return data;
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
  $("#city-filter").addEventListener("change", (e) => {
    state.city = e.target.value;
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
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.sheet) return closeSheet();
    if (state.view === "pick" && !state.sheet && $("#swipe-stack") && !e.target.closest("input, textarea, select")) {
      if (e.key === "ArrowRight") swipe(true);
      if (e.key === "ArrowLeft") swipe(false);
    }
  });
  $("#login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    login($("#login-code").value);
  });

  // Delegated clicks for content that gets re-rendered.
  document.addEventListener("click", async (e) => {
    const t = e.target.closest(
      "[data-open],[data-go],[data-filter],[data-more-filters],[data-pick],[data-pick-mode],[data-clear-all],[data-theme-mode],[data-theme-accent],[data-tag],[data-clear],[data-dismiss],[data-units],[data-copy],[data-copy-token],[data-export],[data-banner-close],[data-revoke-member],[data-revoke-link],[data-share-url],[data-debug-share],[data-copy-debug],[data-archived-view],[data-archive-closed],#recheck-btn,#refresh-btn,#signout-btn,#paste-btn,[data-act]",
    );
    if (!t) return;
    if (t.dataset.open) return openPlace(t.dataset.open);
    if (t.dataset.moreFilters !== undefined) return openMoreFilters();
    if (t.dataset.pick) return pickAction(t);
    if (t.dataset.pickMode) {
      state.pickMode = t.dataset.pickMode;
      return renderPick();
    }
    if (t.dataset.go) {
      closeSheet();
      return setView(t.dataset.go);
    }
    if (t.dataset.tag) {
      closeSheet();
      startFresh();
      state.filters = [t.dataset.tag];
      return setView("list");
    }
    if (t.dataset.themeMode || t.dataset.themeAccent) {
      setTheme(t.dataset.themeMode ? { mode: t.dataset.themeMode } : { accent: t.dataset.themeAccent });
      return renderSettings();
    }
    if (t.dataset.filter) {
      const f = t.dataset.filter;
      state.filters = state.filters.includes(f) ? state.filters.filter((x) => x !== f) : [...state.filters, f];
      fitted = false;
      render();
      if (state.sheet?.type === "more") openMoreFilters();
      return;
    }
    if (t.dataset.clearAll !== undefined) {
      clearAllFilters();
      render();
      if (state.sheet?.type === "more") openMoreFilters();
      return;
    }
    if (t.dataset.clear) {
      state[t.dataset.clear] = "";
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
    if (t.dataset.debugShare) return openShareDebug(t.dataset.debugShare);
    if (t.dataset.copyDebug !== undefined) return copy(JSON.stringify(lastDebug, null, 2));
    if (t.dataset.archivedView) {
      state.archivedView = t.dataset.archivedView === "1";
      renderList();
      $("#view-list").scrollTop = 0;
      return;
    }
    if (t.dataset.archiveClosed !== undefined) {
      const closed = state.places.filter((p) => closedForGood(p) && p.visit_status === "want" && !isArchived(p));
      t.disabled = true;
      for (const p of closed) {
        await api(`/api/places/${p.id}`, { method: "PATCH", body: { archived: true, archive_reason: "closed" } }).catch(() => {});
      }
      await refresh().catch(() => {});
      return toast(
        closed.length === 1 ? `Archived ${closed[0].name}. It's under Archived at the bottom of the list.` : `Archived ${closed.length} places. They're under Archived at the bottom of the list.`,
      );
    }
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
    if (form.dataset.pickForm === "join") {
      e.preventDefault();
      const name = form.elements.name.value.trim();
      if (name) joinPickAs(name);
      return;
    }
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
    if (form.dataset.actForm === "look-again") {
      e.preventDefault();
      const p = state.places.find((x) => x.id === state.sheet?.id);
      if (p) runLookAgain(p);
      return;
    }
    if (form.dataset.actForm === "edit") {
      e.preventDefault();
      const tags = [...form.querySelectorAll('input[name="tag"]:checked')].map((x) => x.value);
      const body = {
        name: $("#edit-name").value,
        category: $("#edit-category").value,
        cuisine: $("#edit-cuisine").value,
        summary: $("#edit-summary").value,
        dishes: $("#edit-dishes").value.split(","),
        instagram_handle: $("#edit-instagram").value,
        go_soon: $("#edit-go-soon").value,
        tags,
      };
      // Only a changed menu link counts as set by hand.
      const menu = $("#edit-menu");
      if (menu.value.trim() !== menu.dataset.was) body.menu_url = menu.value;
      return patchPlace(state.sheet.id, body, "Saved.");
    }
  });

  // "toggle" doesn't bubble, so listen while it's on its way down.
  document.addEventListener(
    "toggle",
    (e) => {
      const d = e.target;
      if (d instanceof HTMLDetailsElement && d.open && d.dataset.debugPlace && !d.dataset.loaded) {
        d.dataset.loaded = "1";
        loadDebug(d.querySelector(".debug-box"), `/api/places/${enc(d.dataset.debugPlace)}/debug`);
      }
    },
    true,
  );

  document.addEventListener("change", (e) => {
    if (e.target.id === "place-notes" && state.sheet?.type === "place") {
      patchPlace(state.sheet.id, { notes: e.target.value }, "Notes saved.");
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && (state.token || state.guest)) refresh().catch(() => {});
    if (document.visibilityState === "visible" && state.view === "pick" && !state.guest?.pick) refreshPick();
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
  if (act === "edit-open") {
    const box = $("#edit-details");
    if (!box) return;
    box.open = true;
    box.scrollIntoView({ behavior: "smooth", block: "start" });
    $("#edit-name")?.focus({ preventScroll: true });
    return;
  }
  const p = state.places.find((x) => x.id === id);
  if (!p) return;
  if (act === "look-apply") return applyLookAgain(p);
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
  if (act === "archive-open") {
    const box = $("#archive-reasons");
    box.hidden = !box.hidden;
    t.setAttribute("aria-expanded", String(!box.hidden));
    return;
  }
  if (act === "archive") {
    return patchPlace(id, { archived: true, archive_reason: t.dataset.reason }, "Archived. It's under Archived at the bottom of the list.");
  }
  if (act === "unarchive") return patchPlace(id, { archived: false }, "Back on your list.");
  if (act === "branch") return patchPlace(id, { branch_id: t.dataset.id }, "Switched location. It stays put when you move.");
  if (act === "nearest-branch") return patchPlace(id, { keep_branch: false }, "Switched to the branch closest to home.");
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
async function shareLink(url, title, text) {
  if (navigator.share) {
    try {
      await navigator.share(text ? { title, text, url } : { title, url });
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

function pickLinkToken() {
  const m = location.pathname.match(/^\/p\/([\w-]{16,64})\/?$/);
  return m ? m[1] : null;
}

/** Someone opened a pick's link without being signed in: just the pick, no tabs. */
async function bootPickGuest(token) {
  state.guest = { token: null, pick: token, label: "" };
  state.pick = { token, data: null, ended: null };
  document.body.classList.add("guest", "pick-only");
  $("#tally").textContent = "Pick a place";
  bindUI();
  setView("pick");
  await openPick(token);
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
  const pickLink = pickLinkToken();
  if (pickLink && !store.get(TOKEN_KEY)) return bootPickGuest(pickLink);

  try {
    const prefs = JSON.parse(store.get(PREFS_KEY) || "{}");
    if (["map", "list", "pick"].includes(prefs.view)) state.view = prefs.view;
    // Browse is part of the list now.
    if (prefs.view === "cats") state.view = "list";
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
  // A pick's link opened by someone who's signed in: show it on the Pick tab.
  if (pickLink) {
    store.set(PICK_KEY, pickLink);
    pickLinkOpened = pickLink;
    state.view = "pick";
    history.replaceState(null, "", "/");
  }
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

applyTheme();
boot();
