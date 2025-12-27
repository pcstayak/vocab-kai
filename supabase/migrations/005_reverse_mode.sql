-- Migration 005: Reverse Mode
-- Creates tables and functions for the reverse gaming mode (definition-based quiz)
-- Supports up to 5 players per room with simultaneous answering

-- Main room table
CREATE TABLE IF NOT EXISTS vocab_reverse_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_code TEXT NOT NULL UNIQUE,
  host_id UUID NOT NULL REFERENCES vocab_users(id) ON DELETE CASCADE,

  -- Game state
  status TEXT NOT NULL DEFAULT 'waiting', -- 'waiting', 'active', 'question', 'results', 'finished'

  -- Game configuration
  total_questions INTEGER DEFAULT 10,
  current_question_index INTEGER DEFAULT 0,

  -- Current question data (JSONB)
  current_question JSONB, -- {wordId, word, definition, options: [{id, word}]}

  -- Game words (selected at start)
  game_words JSONB DEFAULT '[]'::jsonb, -- Array of {id, word, hint, definition, imageUrl}

  -- Timing
  question_start_time TIMESTAMPTZ,
  question_duration_ms INTEGER DEFAULT 15000, -- 15 seconds per question

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Players table (supports 1-5 players per room)
CREATE TABLE IF NOT EXISTS vocab_reverse_players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES vocab_reverse_rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES vocab_users(id) ON DELETE CASCADE,
  player_name TEXT NOT NULL,

  -- Join order (1-5)
  join_order INTEGER NOT NULL,

  -- Game state
  total_score INTEGER DEFAULT 0,

  -- Session tracking
  is_connected BOOLEAN DEFAULT true,
  last_heartbeat TIMESTAMPTZ DEFAULT NOW(),

  joined_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(room_id, user_id),
  CHECK(join_order >= 1 AND join_order <= 5)
);

-- Answers table (tracks each player's answer per question)
CREATE TABLE IF NOT EXISTS vocab_reverse_answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES vocab_reverse_rooms(id) ON DELETE CASCADE,
  question_index INTEGER NOT NULL,
  user_id UUID NOT NULL REFERENCES vocab_users(id) ON DELETE CASCADE,

  -- Answer data
  selected_word_id TEXT NOT NULL, -- The word ID they selected
  is_correct BOOLEAN NOT NULL,
  was_only_correct BOOLEAN DEFAULT false, -- Bonus point flag
  points_earned INTEGER DEFAULT 0, -- 1 for correct, +1 for bonus

  -- Timing
  answer_time_ms INTEGER, -- How long it took to answer
  answered_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(room_id, question_index, user_id)
);

-- Indexes for performance
CREATE INDEX idx_reverse_room_code ON vocab_reverse_rooms(room_code);
CREATE INDEX idx_reverse_rooms_status ON vocab_reverse_rooms(status);
CREATE INDEX idx_reverse_players_room ON vocab_reverse_players(room_id);
CREATE INDEX idx_reverse_players_user ON vocab_reverse_players(user_id);
CREATE INDEX idx_reverse_answers_room_question ON vocab_reverse_answers(room_id, question_index);

-- Function to create a new reverse room
CREATE OR REPLACE FUNCTION create_reverse_room(creator_user_id UUID)
RETURNS TABLE(room_code TEXT, room_id UUID) AS $$
DECLARE
  new_code TEXT;
  new_room_id UUID;
  v_user_name TEXT;
  max_attempts INTEGER := 10;
  attempt INTEGER := 0;
BEGIN
  -- Get user name
  SELECT name INTO v_user_name
  FROM vocab_users
  WHERE id = creator_user_id;

  IF v_user_name IS NULL THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  LOOP
    new_code := generate_room_code(); -- Reuse existing function from versus mode
    attempt := attempt + 1;

    BEGIN
      -- Create room
      INSERT INTO vocab_reverse_rooms (room_code, host_id, status)
      VALUES (new_code, creator_user_id, 'waiting')
      RETURNING id INTO new_room_id;

      -- Create player entry for host
      INSERT INTO vocab_reverse_players (room_id, user_id, player_name, join_order)
      VALUES (new_room_id, creator_user_id, v_user_name, 1);

      EXIT; -- Success, exit loop
    EXCEPTION WHEN unique_violation THEN
      IF attempt >= max_attempts THEN
        RAISE EXCEPTION 'Could not generate unique room code after % attempts', max_attempts;
      END IF;
      -- Try again with a new code
    END;
  END LOOP;

  RETURN QUERY SELECT new_code, new_room_id;
END;
$$ LANGUAGE plpgsql;

-- Function to join a reverse room
CREATE OR REPLACE FUNCTION join_reverse_room(
  p_room_code TEXT,
  p_user_id UUID
)
RETURNS UUID AS $$
DECLARE
  v_room_id UUID;
  v_status TEXT;
  v_player_count INTEGER;
  v_next_join_order INTEGER;
  v_user_name TEXT;
BEGIN
  -- Get room details
  SELECT id, status INTO v_room_id, v_status
  FROM vocab_reverse_rooms
  WHERE room_code = p_room_code;

  IF v_room_id IS NULL THEN
    RAISE EXCEPTION 'Room not found';
  END IF;

  -- Check if player already in room (allow rejoin)
  IF EXISTS (SELECT 1 FROM vocab_reverse_players
             WHERE room_id = v_room_id AND user_id = p_user_id) THEN
    -- Update connection status
    UPDATE vocab_reverse_players
    SET is_connected = true, last_heartbeat = NOW()
    WHERE room_id = v_room_id AND user_id = p_user_id;

    RETURN v_room_id;
  END IF;

  -- New join - check constraints
  IF v_status != 'waiting' THEN
    RAISE EXCEPTION 'Room has already started';
  END IF;

  -- Check player count
  SELECT COUNT(*) INTO v_player_count
  FROM vocab_reverse_players
  WHERE room_id = v_room_id;

  IF v_player_count >= 5 THEN
    RAISE EXCEPTION 'Room is full (maximum 5 players)';
  END IF;

  -- Get next join order
  SELECT COALESCE(MAX(join_order), 0) + 1 INTO v_next_join_order
  FROM vocab_reverse_players
  WHERE room_id = v_room_id;

  -- Get user name
  SELECT name INTO v_user_name
  FROM vocab_users
  WHERE id = p_user_id;

  IF v_user_name IS NULL THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  -- Add player
  INSERT INTO vocab_reverse_players (room_id, user_id, player_name, join_order)
  VALUES (v_room_id, p_user_id, v_user_name, v_next_join_order);

  RETURN v_room_id;
END;
$$ LANGUAGE plpgsql;

-- Helper function to increment player score
CREATE OR REPLACE FUNCTION increment_reverse_score(
  p_room_id UUID,
  p_user_id UUID,
  p_points INTEGER
)
RETURNS VOID AS $$
BEGIN
  UPDATE vocab_reverse_players
  SET total_score = total_score + p_points
  WHERE room_id = p_room_id AND user_id = p_user_id;
END;
$$ LANGUAGE plpgsql;

-- Enable realtime for reverse mode tables
ALTER PUBLICATION supabase_realtime ADD TABLE vocab_reverse_rooms;
ALTER PUBLICATION supabase_realtime ADD TABLE vocab_reverse_players;
ALTER PUBLICATION supabase_realtime ADD TABLE vocab_reverse_answers;
