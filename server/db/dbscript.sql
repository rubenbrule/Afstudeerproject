ALTER TABLE prompts ADD COLUMN assistant_id TEXT;
ALTER TABLE prompts ADD COLUMN vector_store_id TEXT;
ALTER TABLE prompts ADD COLUMN file_ids TEXT; -- JSON [{id,name}]