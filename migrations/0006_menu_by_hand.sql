-- 1 when the menu link was set (or cleared) by hand, so the daily menu search leaves it alone.
ALTER TABLE places ADD COLUMN menu_by_hand INTEGER NOT NULL DEFAULT 0;
