-- Create versus_rooms table for two-player competitive mode
CREATE TABLE IF NOT EXISTS vocab_versus_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_code TEXT NOT NULL UNIQUE,
  player_a_id TEXT NOT NULL REFERENCES vocab_users(id) ON DELETE CASCADE,
  player_b_id TEXT REFERENCES vocab_users(id) ON DELETE CASCADE,

  -- Game state
  status TEXT NOT NULL DEFAULT 'waiting', -- 'waiting', 'active', 'finished'
  current_turn TEXT, -- player_a_id or player_b_id

  -- Words for each player (10 words from opponent's due list)
  player_a_words JSONB DEFAULT '[]'::jsonb, -- Words player A must guess
  player_b_words JSONB DEFAULT '[]'::jsonb, -- Words player B must guess

  -- Progress tracking
  player_a_index INTEGER DEFAULT 0, -- Current word index for player A
  player_b_index INTEGER DEFAULT 0, -- Current word index for player B
  player_a_wrong_count INTEGER DEFAULT 0,
  player_b_wrong_count INTEGER DEFAULT 0,
  player_a_right_count INTEGER DEFAULT 0,
  player_b_right_count INTEGER DEFAULT 0,

  -- Timer tracking (milliseconds)
  player_a_time INTEGER DEFAULT 0,
  player_b_time INTEGER DEFAULT 0,
  turn_start_time TIMESTAMPTZ,

  -- Winner
  winner_id TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for quick room code lookups
CREATE INDEX idx_room_code ON vocab_versus_rooms(room_code);
CREATE INDEX idx_versus_rooms_status ON vocab_versus_rooms(status);

-- Function to generate a short room code (4 characters)
CREATE OR REPLACE FUNCTION generate_room_code()
RETURNS TEXT AS $$
DECLARE
  chars TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; -- Avoid confusing chars like O,0,I,1
  result TEXT := '';
  i INTEGER;
BEGIN
  FOR i IN 1..4 LOOP
    result := result || substr(chars, floor(random() * length(chars) + 1)::int, 1);
  END LOOP;
  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Function to create a new versus room
CREATE OR REPLACE FUNCTION create_versus_room(creator_user_id TEXT)
RETURNS TABLE(room_code TEXT, room_id UUID) AS $$
DECLARE
  new_code TEXT;
  new_room_id UUID;
  max_attempts INTEGER := 10;
  attempt INTEGER := 0;
BEGIN
  LOOP
    new_code := generate_room_code();
    attempt := attempt + 1;

    -- Try to insert with this code
    BEGIN
      INSERT INTO vocab_versus_rooms (room_code, player_a_id, status)
      VALUES (new_code, creator_user_id, 'waiting')
      RETURNING id INTO new_room_id;

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

-- Function to join a versus room
CREATE OR REPLACE FUNCTION join_versus_room(
  p_room_code TEXT,
  p_user_id TEXT
)
RETURNS UUID AS $$
DECLARE
  v_room_id UUID;
  v_player_a_id TEXT;
  v_player_b_id TEXT;
  v_status TEXT;
BEGIN
  -- Get room details
  SELECT id, player_a_id, player_b_id, status
  INTO v_room_id, v_player_a_id, v_player_b_id, v_status
  FROM vocab_versus_rooms
  WHERE room_code = p_room_code;

  IF v_room_id IS NULL THEN
    RAISE EXCEPTION 'Room not found';
  END IF;

  IF v_status != 'waiting' THEN
    RAISE EXCEPTION 'Room is not available';
  END IF;

  IF v_player_a_id = p_user_id THEN
    RAISE EXCEPTION 'Cannot join your own room';
  END IF;

  IF v_player_b_id IS NOT NULL THEN
    RAISE EXCEPTION 'Room is full';
  END IF;

  -- Join the room
  UPDATE vocab_versus_rooms
  SET player_b_id = p_user_id,
      updated_at = NOW()
  WHERE id = v_room_id;

  RETURN v_room_id;
END;
$$ LANGUAGE plpgsql;

-- Enable realtime for versus rooms
ALTER PUBLICATION supabase_realtime ADD TABLE vocab_versus_rooms;
