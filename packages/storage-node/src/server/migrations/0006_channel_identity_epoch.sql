-- The v6 channel schema omitted the seed required by sync cursor identity.
-- Repair only an empty identity table; never rotate a retained legacy epoch.
INSERT INTO actor_channel_identity(epoch)
SELECT lower(hex(randomblob(16)))
WHERE NOT EXISTS (SELECT 1 FROM actor_channel_identity);

--> statement-breakpoint
-- Drizzle's table snapshot cannot express these published channel change hooks.
CREATE TRIGGER actor_channel_message_inserted AFTER INSERT ON actor_messages
  WHEN new.target_kind IN ('actor','channel') BEGIN
    INSERT INTO actor_channel_changes(channel_id,message_id) VALUES(new.channel_id,new.id);
END;
CREATE TRIGGER actor_channel_request_linked AFTER INSERT ON actor_execution_inputs BEGIN
    INSERT OR REPLACE INTO actor_channel_changes(channel_id,message_id)
      SELECT channel_id,id FROM actor_messages WHERE id=new.message_id AND target_kind IN ('actor','channel');
END;
--> statement-breakpoint
-- Recover messages written while v6 had no change trigger, without replacing
-- retained revisions or rotating the cursor namespace.
INSERT INTO actor_channel_changes(channel_id,message_id)
SELECT m.channel_id,m.id FROM actor_messages m
WHERE m.target_kind IN ('actor','channel')
  AND NOT EXISTS (SELECT 1 FROM actor_channel_changes c WHERE c.message_id=m.id)
ORDER BY m.seq;
