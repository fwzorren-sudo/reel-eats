-- Pick: a short list of places to swipe through with whoever's going out, shared by link.
-- relay: each person swipes what's left, and a place anyone drops is gone.
-- vote: everyone swipes the whole set, and the places are ranked by how many kept them.
CREATE TABLE IF NOT EXISTS picks (
  token TEXT PRIMARY KEY,
  mode TEXT NOT NULL,                                 -- relay | vote
  label TEXT,                                         -- the filters it started from, e.g. "Date night · Decatur"
  place_ids TEXT NOT NULL,                            -- JSON array, in the order the cards come
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Anyone with the link joins by typing a name. The id is made on their phone and kept there.
CREATE TABLE IF NOT EXISTS pick_people (
  token TEXT NOT NULL,
  voter_id TEXT NOT NULL,
  name TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (token, voter_id)
);

CREATE TABLE IF NOT EXISTS pick_votes (
  token TEXT NOT NULL,
  voter_id TEXT NOT NULL,
  place_id TEXT NOT NULL,
  keep INTEGER NOT NULL,                              -- 1 kept, 0 dropped
  created_at INTEGER NOT NULL,
  PRIMARY KEY (token, voter_id, place_id)
);

CREATE INDEX IF NOT EXISTS picks_expiry ON picks (expires_at);
