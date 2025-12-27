import { supabase } from './supabase'
import type { RealtimeChannel } from '@supabase/supabase-js'

export type VersusRoomStatus = 'waiting' | 'active' | 'finished'

export type VersusWord = {
  id: string
  word: string
  hint: string
  definition: string
}

export type VersusRoom = {
  id: string
  roomCode: string
  playerAId: string
  playerBId: string | null
  playerAName?: string
  playerBName?: string
  status: VersusRoomStatus
  currentTurn: string | null
  playerAWords: VersusWord[]
  playerBWords: VersusWord[]
  playerAIndex: number
  playerBIndex: number
  playerAWrongCount: number
  playerBWrongCount: number
  playerARightCount: number
  playerBRightCount: number
  playerATime: number
  playerBTime: number
  turnStartTime: string | null
  winnerId: string | null
  createdAt: string
  updatedAt: string
}

// Create a new versus room
export async function createVersusRoom(userId: string): Promise<{ roomCode: string; roomId: string }> {
  const { data, error } = await (supabase as any).rpc('create_versus_room', {
    creator_user_id: userId,
  })

  if (error) throw error
  if (!data || data.length === 0) throw new Error('Failed to create room')

  return {
    roomCode: data[0].room_code,
    roomId: data[0].room_id,
  }
}

// Join an existing versus room
export async function joinVersusRoom(roomCode: string, userId: string): Promise<string> {
  const { data, error } = await (supabase as any).rpc('join_versus_room', {
    p_room_code: roomCode,
    p_user_id: userId,
  })

  if (error) throw error
  return data as string
}

// Get room details
export async function getVersusRoom(roomId: string): Promise<VersusRoom | null> {
  const { data, error } = await supabase
    .from('vocab_versus_rooms')
    .select(`
      *,
      player_a:vocab_users!vocab_versus_rooms_player_a_id_fkey(name),
      player_b:vocab_users!vocab_versus_rooms_player_b_id_fkey(name)
    `)
    .eq('id', roomId)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null // Not found
    throw error
  }

  return mapRoomFromDb(data)
}

// Update room state
export async function updateVersusRoom(
  roomId: string,
  updates: Partial<{
    status: VersusRoomStatus
    currentTurn: string | null
    playerAIndex: number
    playerBIndex: number
    playerAWrongCount: number
    playerBWrongCount: number
    playerARightCount: number
    playerBRightCount: number
    playerATime: number
    playerBTime: number
    turnStartTime: string | null
    winnerId: string | null
  }>
): Promise<void> {
  const dbUpdates: any = {
    updated_at: new Date().toISOString(),
  }

  if (updates.status !== undefined) dbUpdates.status = updates.status
  if (updates.currentTurn !== undefined) dbUpdates.current_turn = updates.currentTurn
  if (updates.playerAIndex !== undefined) dbUpdates.player_a_index = updates.playerAIndex
  if (updates.playerBIndex !== undefined) dbUpdates.player_b_index = updates.playerBIndex
  if (updates.playerAWrongCount !== undefined)
    dbUpdates.player_a_wrong_count = updates.playerAWrongCount
  if (updates.playerBWrongCount !== undefined)
    dbUpdates.player_b_wrong_count = updates.playerBWrongCount
  if (updates.playerARightCount !== undefined)
    dbUpdates.player_a_right_count = updates.playerARightCount
  if (updates.playerBRightCount !== undefined)
    dbUpdates.player_b_right_count = updates.playerBRightCount
  if (updates.playerATime !== undefined) dbUpdates.player_a_time = updates.playerATime
  if (updates.playerBTime !== undefined) dbUpdates.player_b_time = updates.playerBTime
  if (updates.turnStartTime !== undefined) dbUpdates.turn_start_time = updates.turnStartTime
  if (updates.winnerId !== undefined) dbUpdates.winner_id = updates.winnerId

  const { error } = await (supabase as any)
    .from('vocab_versus_rooms')
    .update(dbUpdates)
    .eq('id', roomId)

  if (error) throw error
}

// Start the game (set words and initial state)
export async function startVersusGame(
  roomId: string,
  playerAWords: VersusWord[],
  playerBWords: VersusWord[]
): Promise<void> {
  const { error } = await (supabase as any)
    .from('vocab_versus_rooms')
    .update({
      status: 'active',
      player_a_words: playerAWords,
      player_b_words: playerBWords,
      player_a_index: 0,
      player_b_index: 0,
      player_a_wrong_count: 0,
      player_b_wrong_count: 0,
      player_a_right_count: 0,
      player_b_right_count: 0,
      player_a_time: 0,
      player_b_time: 0,
      winner_id: null,
      current_turn: (await getVersusRoom(roomId))?.playerAId, // Player A starts
      turn_start_time: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', roomId)

  if (error) throw error
}

// Delete a versus room
export async function deleteVersusRoom(roomId: string): Promise<void> {
  const { error } = await (supabase as any)
    .from('vocab_versus_rooms')
    .delete()
    .eq('id', roomId)

  if (error) throw error
}

// Subscribe to room updates
export function subscribeToVersusRoom(
  roomId: string,
  callback: (room: VersusRoom) => void
): RealtimeChannel {
  const channel = supabase
    .channel(`versus-room-${roomId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'vocab_versus_rooms',
        filter: `id=eq.${roomId}`,
      },
      (payload) => {
        const payloadData = payload.new as any
        console.log('Realtime payload received:', {
          eventType: payload.eventType,
          hasNew: !!payload.new,
          hasOld: !!payload.old,
          newPlayerAWords: payloadData?.player_a_words,
          newPlayerBWords: payloadData?.player_b_words,
          newPlayerAWordsType: typeof payloadData?.player_a_words,
          newPlayerBWordsType: typeof payloadData?.player_b_words,
        })

        if (payload.new) {
          const mappedRoom = mapRoomFromDb(payloadData)
          console.log('Mapped room:', {
            playerAWordsLength: mappedRoom.playerAWords.length,
            playerBWordsLength: mappedRoom.playerBWords.length,
          })
          callback(mappedRoom)
        }
      }
    )
    .subscribe()

  return channel
}

// Helper to map database row to VersusRoom
function mapRoomFromDb(data: any): VersusRoom {
  // Parse JSONB columns if they come as strings (from realtime)
  let playerAWords = data.player_a_words || []
  let playerBWords = data.player_b_words || []

  if (typeof playerAWords === 'string') {
    try {
      playerAWords = JSON.parse(playerAWords)
    } catch (e) {
      console.error('Failed to parse playerAWords:', e)
      playerAWords = []
    }
  }

  if (typeof playerBWords === 'string') {
    try {
      playerBWords = JSON.parse(playerBWords)
    } catch (e) {
      console.error('Failed to parse playerBWords:', e)
      playerBWords = []
    }
  }

  // Ensure arrays are actually arrays
  if (!Array.isArray(playerAWords)) playerAWords = []
  if (!Array.isArray(playerBWords)) playerBWords = []

  console.log('mapRoomFromDb:', {
    playerAWordsLength: playerAWords.length,
    playerBWordsLength: playerBWords.length,
    playerAWordsType: typeof data.player_a_words,
    playerBWordsType: typeof data.player_b_words,
    playerAIndex: data.player_a_index,
    playerBIndex: data.player_b_index,
  })

  return {
    id: data.id,
    roomCode: data.room_code,
    playerAId: data.player_a_id,
    playerBId: data.player_b_id,
    playerAName: data.player_a?.name,
    playerBName: data.player_b?.name,
    status: data.status,
    currentTurn: data.current_turn,
    playerAWords,
    playerBWords,
    playerAIndex: data.player_a_index || 0,
    playerBIndex: data.player_b_index || 0,
    playerAWrongCount: data.player_a_wrong_count || 0,
    playerBWrongCount: data.player_b_wrong_count || 0,
    playerARightCount: data.player_a_right_count || 0,
    playerBRightCount: data.player_b_right_count || 0,
    playerATime: data.player_a_time || 0,
    playerBTime: data.player_b_time || 0,
    turnStartTime: data.turn_start_time,
    winnerId: data.winner_id,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  }
}
