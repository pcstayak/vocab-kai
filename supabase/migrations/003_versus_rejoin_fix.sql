-- Migration 003: Fix versus mode to support rejoining and correct UUID types

-- Update column types from TEXT to UUID (if they're still TEXT)
DO $$
BEGIN
    -- Only alter if columns are TEXT type
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'vocab_versus_rooms'
        AND column_name = 'player_a_id'
        AND data_type = 'text'
    ) THEN
        ALTER TABLE vocab_versus_rooms
            ALTER COLUMN player_a_id TYPE UUID USING player_a_id::uuid,
            ALTER COLUMN player_b_id TYPE UUID USING player_b_id::uuid,
            ALTER COLUMN current_turn TYPE UUID USING current_turn::uuid,
            ALTER COLUMN winner_id TYPE UUID USING winner_id::uuid;
    END IF;
END $$;

-- Drop old function signatures if they exist
DROP FUNCTION IF EXISTS create_versus_room(TEXT);
DROP FUNCTION IF EXISTS join_versus_room(TEXT, TEXT);

-- Recreate function with UUID parameter
CREATE OR REPLACE FUNCTION create_versus_room(creator_user_id UUID)
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

-- Recreate join function with rejoin support
CREATE OR REPLACE FUNCTION join_versus_room(
  p_room_code TEXT,
  p_user_id UUID
)
RETURNS UUID AS $$
DECLARE
  v_room_id UUID;
  v_player_a_id UUID;
  v_player_b_id UUID;
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

  -- Allow rejoining if user is already a player in this room
  IF v_player_a_id = p_user_id OR v_player_b_id = p_user_id THEN
    -- User is already in this room, allow them to rejoin
    RETURN v_room_id;
  END IF;

  -- For new joins, only allow if room is waiting
  IF v_status != 'waiting' THEN
    RAISE EXCEPTION 'Room is not available';
  END IF;

  IF v_player_b_id IS NOT NULL THEN
    RAISE EXCEPTION 'Room is full';
  END IF;

  -- Join the room as player B
  UPDATE vocab_versus_rooms
  SET player_b_id = p_user_id,
      updated_at = NOW()
  WHERE id = v_room_id;

  RETURN v_room_id;
END;
$$ LANGUAGE plpgsql;
