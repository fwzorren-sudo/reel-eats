-- Key/value settings such as the home location.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per thing shared into the app (a reel link, a screenshot, or a typed name).
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | processing | done | failed
  source_url TEXT,
  shared_text TEXT,
  note TEXT,
  image_base64 TEXT,
  image_type TEXT,
  source_author TEXT,
  source_caption TEXT,
  source_thumb TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS shares_status ON shares(status);
CREATE INDEX IF NOT EXISTS shares_source_url ON shares(source_url);

-- One row per restaurant. A single reel can produce several.
CREATE TABLE IF NOT EXISTS places (
  id TEXT PRIMARY KEY,
  share_id TEXT,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Other',
  cuisine TEXT,
  summary TEXT,
  dishes TEXT,                 -- JSON array of strings
  search_query TEXT,           -- what to search on Google Maps to find branches
  city_hint TEXT,              -- city/area the reel was filmed in, if known
  multi_location INTEGER NOT NULL DEFAULT 0,
  located INTEGER NOT NULL DEFAULT 0,
  google_place_id TEXT,
  address TEXT,
  city TEXT,
  lat REAL,
  lng REAL,
  distance_m REAL,             -- from home, at the time of lookup
  branch_count INTEGER NOT NULL DEFAULT 0,
  branches TEXT,               -- JSON array of other branches found
  maps_url TEXT,
  website TEXT,
  phone TEXT,
  rating REAL,
  rating_count INTEGER,
  price_level TEXT,
  business_status TEXT,
  source_url TEXT,
  source_author TEXT,
  source_caption TEXT,
  visit_status TEXT NOT NULL DEFAULT 'want',  -- want | visited
  my_rating INTEGER,
  notes TEXT,
  visited_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS places_google_place_id ON places(google_place_id);
CREATE INDEX IF NOT EXISTS places_share_id ON places(share_id);
