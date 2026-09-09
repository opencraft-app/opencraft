-- Historical tombstone.
--
-- Version 29 was already recorded by some test databases before its original
-- schema change was folded into version 28. Keep this no-op migration so
-- golang-migrate can advance those databases from 29 to later versions.
SELECT 1;
