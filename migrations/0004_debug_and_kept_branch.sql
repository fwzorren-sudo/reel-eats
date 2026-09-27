-- A log of each attempt to process a share: which outside calls were made, how long each took,
-- what came back, and how it ended. Shown under "Debugging details" in the app.
ALTER TABLE shares ADD COLUMN debug TEXT;

-- 1 when the saved branch shouldn't be swapped for the one nearest home: a pop-up or event at
-- the branch in the reel, or a branch picked by hand.
ALTER TABLE places ADD COLUMN keep_branch INTEGER NOT NULL DEFAULT 0;
