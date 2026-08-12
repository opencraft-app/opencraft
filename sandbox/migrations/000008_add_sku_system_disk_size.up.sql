-- SKU owns the instance system disk specification inherited by derived pools.
ALTER TABLE skus
  ADD COLUMN system_disk_size INT NOT NULL DEFAULT 50 AFTER instance_type;

-- The 4C8G product contract includes an 80GB system disk. Backfill every SKU
-- already attached to that template class so newly derived pools are correct
-- immediately after migration.
UPDATE skus
SET system_disk_size = 80
WHERE template_class_id = 'openclaw-4c8g80g';
