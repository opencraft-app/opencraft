-- NOTE: website IDs use crypto/rand (see logic.go generateID), not id_gen table.
-- These seed entries are unused but harmless; kept for potential future migration to sequential IDs.
INSERT IGNORE INTO `id_gen` (`name`, `max_id`) VALUES
    ('website_site', 0),
    ('website_release', 0),
    ('website_operation', 0);
