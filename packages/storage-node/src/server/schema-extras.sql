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
