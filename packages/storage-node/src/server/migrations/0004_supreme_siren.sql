CREATE TABLE `conversation_search_documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`thread_id` text NOT NULL,
	`record_id` text NOT NULL,
	`group_id` text,
	`item_id` text,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`text` text NOT NULL,
	`title_tokens` text NOT NULL,
	`text_tokens` text NOT NULL,
	`source_revision` integer NOT NULL,
	FOREIGN KEY (`scope`,`thread_id`) REFERENCES `conversation_threads`(`scope`,`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_search_identity` ON `conversation_search_documents` (`scope`,`thread_id`,`record_id`);--> statement-breakpoint
ALTER TABLE `conversation_threads` ADD `search_revision` integer DEFAULT -1 NOT NULL;
--> statement-breakpoint
-- SQLite-native derived index objects not represented by Drizzle's table DSL.
CREATE VIRTUAL TABLE conversation_search USING fts5(title_tokens, text_tokens, content='conversation_search_documents', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER conversation_search_insert AFTER INSERT ON conversation_search_documents BEGIN
  INSERT INTO conversation_search(rowid,title_tokens,text_tokens) VALUES(new.id,new.title_tokens,new.text_tokens);
END;
CREATE TRIGGER conversation_search_delete AFTER DELETE ON conversation_search_documents BEGIN
  INSERT INTO conversation_search(conversation_search,rowid,title_tokens,text_tokens) VALUES('delete',old.id,old.title_tokens,old.text_tokens);
END;
CREATE TRIGGER conversation_search_update AFTER UPDATE ON conversation_search_documents BEGIN
  INSERT INTO conversation_search(conversation_search,rowid,title_tokens,text_tokens) VALUES('delete',old.id,old.title_tokens,old.text_tokens);
  INSERT INTO conversation_search(rowid,title_tokens,text_tokens) VALUES(new.id,new.title_tokens,new.text_tokens);
END;
