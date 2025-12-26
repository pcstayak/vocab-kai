-- Supabase Migration: Multi-User Vocab Trainer
-- This migration creates all tables, indexes, functions, and seed data
-- All tables prefixed with "vocab_" to avoid conflicts

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Table: vocab_users
CREATE TABLE vocab_users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Table: vocab_words (shared vocabulary)
CREATE TABLE vocab_words (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  word TEXT NOT NULL,
  hint TEXT NOT NULL DEFAULT '',
  definition TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Table: vocab_user_progress (per-user learning state)
CREATE TABLE vocab_user_progress (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES vocab_users(id) ON DELETE CASCADE,
  word_id UUID NOT NULL REFERENCES vocab_words(id) ON DELETE CASCADE,
  level_id INTEGER NOT NULL DEFAULT 1,
  streak_correct INTEGER NOT NULL DEFAULT 0,
  total_right INTEGER NOT NULL DEFAULT 0,
  total_wrong INTEGER NOT NULL DEFAULT 0,
  last_reviewed_at TIMESTAMPTZ,
  due_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_result TEXT CHECK (last_result IN ('right', 'wrong', NULL)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, word_id)
);

-- Table: vocab_app_config (singleton for shared SRS settings)
CREATE TABLE vocab_app_config (
  id UUID PRIMARY KEY DEFAULT '00000000-0000-0000-0000-000000000000',
  config_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (id = '00000000-0000-0000-0000-000000000000')
);

-- Indexes
CREATE INDEX idx_vocab_user_progress_user_due ON vocab_user_progress(user_id, due_at);
CREATE INDEX idx_vocab_words_word ON vocab_words(word);

-- Trigger function to auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION vocab_update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = NOW();
   RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for auto-updating updated_at
CREATE TRIGGER update_vocab_words_updated_at
  BEFORE UPDATE ON vocab_words
  FOR EACH ROW
  EXECUTE FUNCTION vocab_update_updated_at_column();

CREATE TRIGGER update_vocab_user_progress_updated_at
  BEFORE UPDATE ON vocab_user_progress
  FOR EACH ROW
  EXECUTE FUNCTION vocab_update_updated_at_column();

CREATE TRIGGER update_vocab_app_config_updated_at
  BEFORE UPDATE ON vocab_app_config
  FOR EACH ROW
  EXECUTE FUNCTION vocab_update_updated_at_column();

-- Function: Create user with progress entries for all existing words
CREATE OR REPLACE FUNCTION vocab_create_user_with_progress(user_name TEXT)
RETURNS UUID AS $$
DECLARE
  new_user_id UUID;
BEGIN
  -- Create the user
  INSERT INTO vocab_users (name)
  VALUES (user_name)
  RETURNING id INTO new_user_id;

  -- Create progress entries for all existing words
  INSERT INTO vocab_user_progress (user_id, word_id, level_id, streak_correct, total_right, total_wrong, due_at)
  SELECT
    new_user_id,
    id,
    1,
    0,
    0,
    0,
    NOW()
  FROM vocab_words;

  RETURN new_user_id;
END;
$$ LANGUAGE plpgsql;

-- Function: Create word with progress entries for all existing users
CREATE OR REPLACE FUNCTION vocab_create_word_for_all_users(
  word_text TEXT,
  hint_text TEXT,
  definition_text TEXT
)
RETURNS UUID AS $$
DECLARE
  new_word_id UUID;
BEGIN
  -- Create the word
  INSERT INTO vocab_words (word, hint, definition)
  VALUES (word_text, hint_text, definition_text)
  RETURNING id INTO new_word_id;

  -- Create progress entries for all existing users
  INSERT INTO vocab_user_progress (user_id, word_id, level_id, streak_correct, total_right, total_wrong, due_at)
  SELECT
    id,
    new_word_id,
    1,
    0,
    0,
    0,
    NOW()
  FROM vocab_users;

  RETURN new_word_id;
END;
$$ LANGUAGE plpgsql;

-- Seed default configuration
INSERT INTO vocab_app_config (id, config_json) VALUES (
  '00000000-0000-0000-0000-000000000000',
  '{
    "levels": [
      {"id": 1, "name": "Level 1", "promoteAfterCorrect": 3, "intervalDays": 1},
      {"id": 2, "name": "Level 2", "promoteAfterCorrect": 2, "intervalDays": 7},
      {"id": 3, "name": "Level 3", "promoteAfterCorrect": 1, "intervalDays": 30}
    ],
    "wrongMakesImmediatelyDue": true,
    "wrongResetsStreak": true
  }'::jsonb
);
