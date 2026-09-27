-- Richer data per reel: the raw Apify results, the transcript, when it was posted and where it was tagged.
ALTER TABLE shares ADD COLUMN raw_post TEXT;
ALTER TABLE shares ADD COLUMN raw_transcript TEXT;
ALTER TABLE shares ADD COLUMN transcript TEXT;
ALTER TABLE shares ADD COLUMN posted_at INTEGER;
ALTER TABLE shares ADD COLUMN source_location TEXT;   -- JSON: name, lat, lng, address
ALTER TABLE shares ADD COLUMN added_by TEXT;          -- member name; NULL means the owner
ALTER TABLE shares ADD COLUMN photo_key TEXT;         -- key into media: the reel's cover image

-- Richer data per restaurant.
ALTER TABLE places ADD COLUMN instagram_handle TEXT;
ALTER TABLE places ADD COLUMN posted_at INTEGER;
ALTER TABLE places ADD COLUMN tags TEXT;              -- JSON array, e.g. ["coffee date","outdoor seating"]
ALTER TABLE places ADD COLUMN go_soon TEXT;           -- e.g. "New opening", "Pop-up through Oct 12"
ALTER TABLE places ADD COLUMN hours TEXT;             -- JSON: Google periods and weekday descriptions
ALTER TABLE places ADD COLUMN time_zone TEXT;         -- e.g. America/New_York, for "open now" in the place's own time
ALTER TABLE places ADD COLUMN utc_offset INTEGER;     -- minutes; used when the time zone is unknown
ALTER TABLE places ADD COLUMN photo_key TEXT;         -- key into media
ALTER TABLE places ADD COLUMN added_by TEXT;
ALTER TABLE places ADD COLUMN refreshed_at INTEGER;   -- last time Google details were refreshed

-- Every reel that recommended a place, not just the first one.
CREATE TABLE IF NOT EXISTS place_sources (
  id TEXT PRIMARY KEY,
  place_id TEXT NOT NULL,
  share_id TEXT,
  source_url TEXT,
  source_author TEXT,
  source_caption TEXT,
  posted_at INTEGER,
  photo_key TEXT,
  added_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS place_sources_place ON place_sources(place_id);
CREATE UNIQUE INDEX IF NOT EXISTS place_sources_unique ON place_sources(place_id, source_url);

INSERT OR IGNORE INTO place_sources (id, place_id, share_id, source_url, source_author, source_caption, created_at)
  SELECT lower(hex(randomblob(16))), id, share_id, source_url, source_author, source_caption, created_at
  FROM places WHERE source_url IS NOT NULL OR source_caption IS NOT NULL;

-- Small images kept from reels, since Instagram's image links expire.
CREATE TABLE IF NOT EXISTS media (
  key TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

-- Read-only links for sharing a list.
CREATE TABLE IF NOT EXISTS share_links (
  token TEXT PRIMARY KEY,
  label TEXT,
  scope TEXT NOT NULL,                                -- JSON: status, category
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

-- Extra access codes, for a partner who adds places too. Only a hash of each code is kept.
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
