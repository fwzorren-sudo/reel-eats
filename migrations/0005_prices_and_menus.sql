-- Google's price range per person, such as "$20–30".
ALTER TABLE places ADD COLUMN price_range TEXT;

-- A link to the menu, found on the restaurant's own website. menu_checked_for is the website
-- that was searched, so a new website (another branch, say) gets searched again.
ALTER TABLE places ADD COLUMN menu_url TEXT;
ALTER TABLE places ADD COLUMN menu_checked_for TEXT;
ALTER TABLE places ADD COLUMN menu_checked_at INTEGER;
