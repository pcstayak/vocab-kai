import { supabase } from './supabase'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { generateQuestion, type Question } from './reverse-word-selection'

export type ReverseRoomStatus = 'waiting' | 'active' | 'question' | 'results' | 'finished'

export type ReversePlayer = {
  id: string
  userId: string
  playerName: string
  joinOrder: number
  totalScore: number
  isConnected: boolean
}

export type ReverseWord = {
  id: string
  word: string
  hint: string
  definition: string
  imageUrl?: string
}

export type ReverseRoom = {
  id: string
  roomCode: string
  hostId: string
  status: ReverseRoomStatus
  totalQuestions: number
  currentQuestionIndex: number
  currentQuestion: Question | null
  gameWords: ReverseWord[]
  questionStartTime: string | null
  questionDurationMs: number
  players: ReversePlayer[]
  createdAt: string
  updatedAt: string
}

export type ReverseAnswer = {
  id: string
  userId: string
  selectedWordId: string
  isCorrect: boolean
  wasOnlyCorrect: boolean
  pointsEarned: number
  answerTimeMs: number
}

export type PlayerStats = {
  userId: string
  playerName: string
  totalScore: number
  correctAnswers: number
  wrongAnswers: number
  bonusPoints: number
  averageAnswerTimeMs: number
  fastestAnswerMs: number
  slowestAnswerMs: number
}

// Create a new reverse room
export async function createReverseRoom(userId: string): Promise<{ roomCode: string; roomId: string }> {
  const { data, error } = await (supabase as any).rpc('create_reverse_room', {
    creator_user_id: userId,
  })

  if (error) throw error
  if (!data || data.length === 0) throw new Error('Failed to create room')

  return {
    roomCode: data[0].room_code,
    roomId: data[0].room_id,
  }
}

// Join an existing reverse room
export async function joinReverseRoom(roomCode: string, userId: string): Promise<string> {
  const { data, error } = await (supabase as any).rpc('join_reverse_room', {
    p_room_code: roomCode,
    p_user_id: userId,
  })

  if (error) throw error
  return data as string
}

// Get room details with all players
export async function getReverseRoom(roomId: string): Promise<ReverseRoom | null> {
  // Get room data
  const { data: roomData, error: roomError } = await (supabase as any)
    .from('vocab_reverse_rooms')
    .select('*')
    .eq('id', roomId)
    .single()

  if (roomError) {
    if (roomError.code === 'PGRST116') return null // Not found
    throw roomError
  }

  // Get players
  const { data: playersData, error: playersError } = await (supabase as any)
    .from('vocab_reverse_players')
    .select('*')
    .eq('room_id', roomId)
    .order('join_order', { ascending: true })

  if (playersError) throw playersError

  return mapRoomFromDb(roomData, playersData || [])
}

// Start game (host only)
export async function startReverseGame(roomId: string, gameWords: ReverseWord[]): Promise<void> {
  const { error } = await (supabase as any)
    .from('vocab_reverse_rooms')
    .update({
      status: 'active',
      game_words: gameWords,
      current_question_index: 0,
      updated_at: new Date().toISOString(),
    })
    .eq('id', roomId)

  if (error) throw error
}

// Advance to next question
export async function advanceToNextQuestion(roomId: string, allWords: any[]): Promise<void> {
  // Get current room state
  const room = await getReverseRoom(roomId)
  if (!room) throw new Error('Room not found')

  const nextIndex = room.currentQuestionIndex + 1

  if (nextIndex >= room.totalQuestions) {
    // Game is over - finalize
    await finalizeGame(roomId)
    return
  }

  // Generate next question
  const nextWord = room.gameWords[nextIndex]
  const question = generateQuestion(nextWord, allWords)

  // Update room
  await updateReverseRoom(roomId, {
    status: 'question',
    currentQuestionIndex: nextIndex,
    currentQuestion: question,
    questionStartTime: new Date().toISOString(),
  })
}

// Submit answer
export async function submitAnswer(
  roomId: string,
  questionIndex: number,
  userId: string,
  selectedWordId: string,
  answerTimeMs: number
): Promise<void> {
  // Get current question
  const room = await getReverseRoom(roomId)
  if (!room || !room.currentQuestion) throw new Error('No active question')

  const isCorrect = selectedWordId === room.currentQuestion.wordId
  const pointsEarned = isCorrect ? 1 : 0

  // Insert answer record
  const { error } = await (supabase as any).from('vocab_reverse_answers').insert({
    room_id: roomId,
    question_index: questionIndex,
    user_id: userId,
    selected_word_id: selectedWordId,
    is_correct: isCorrect,
    points_earned: pointsEarned,
    answer_time_ms: answerTimeMs,
  })

  if (error) {
    // Ignore duplicate submission errors (user clicked multiple times)
    if (error.code === '23505') return
    throw error
  }

  // Update player score if correct
  if (isCorrect) {
    const { error: updateError } = await (supabase as any).rpc('increment_reverse_score', {
      p_room_id: roomId,
      p_user_id: userId,
      p_points: 1,
    })

    // Fallback if RPC doesn't exist
    if (updateError) {
      await (supabase as any)
        .from('vocab_reverse_players')
        .update({ total_score: (supabase as any).sql`total_score + 1` })
        .eq('room_id', roomId)
        .eq('user_id', userId)
    }
  }
}

// Check if all players answered and calculate bonuses
export async function checkAllAnswersAndCalculateBonus(
  roomId: string,
  questionIndex: number
): Promise<boolean> {
  const room = await getReverseRoom(roomId)
  if (!room) return false

  // Get all answers for this question
  const { data: answers, error } = await (supabase as any)
    .from('vocab_reverse_answers')
    .select('*')
    .eq('room_id', roomId)
    .eq('question_index', questionIndex)

  if (error) throw error

  // Check if all players answered
  if (!answers || answers.length < room.players.length) {
    return false // Not all answered yet
  }

  // Calculate bonus points (only one person got it right)
  const correctAnswers = answers.filter((a: any) => a.is_correct)

  if (correctAnswers.length === 1) {
    // Only one person got it right - award bonus point
    const bonusUserId = correctAnswers[0].user_id

    // Update answer record
    await (supabase as any)
      .from('vocab_reverse_answers')
      .update({
        was_only_correct: true,
        points_earned: 2, // 1 base + 1 bonus
      })
      .eq('room_id', roomId)
      .eq('question_index', questionIndex)
      .eq('user_id', bonusUserId)

    // Update player score (+1 bonus)
    const { error: updateError } = await (supabase as any).rpc('increment_reverse_score', {
      p_room_id: roomId,
      p_user_id: bonusUserId,
      p_points: 1,
    })

    // Fallback
    if (updateError) {
      await (supabase as any)
        .from('vocab_reverse_players')
        .update({ total_score: (supabase as any).sql`total_score + 1` })
        .eq('room_id', roomId)
        .eq('user_id', bonusUserId)
    }
  }

  // Switch to results state
  await updateReverseRoom(roomId, {
    status: 'results',
  })

  return true
}

// Finalize game and calculate statistics
async function finalizeGame(roomId: string): Promise<void> {
  // Update room to finished
  await updateReverseRoom(roomId, {
    status: 'finished',
  })
}

// Get game statistics for all players
export async function getPlayerStats(roomId: string): Promise<PlayerStats[]> {
  // Get all answers for this game
  const { data: answers } = await supabase
    .from('vocab_reverse_answers')
    .select('*')
    .eq('room_id', roomId)

  // Get room with players
  const room = await getReverseRoom(roomId)
  if (!room) return []

  // Calculate stats per player
  const stats: PlayerStats[] = room.players.map((player) => {
    const playerAnswers = answers?.filter((a: any) => a.user_id === player.userId) || []

    const correctCount = playerAnswers.filter((a: any) => a.is_correct).length
    const wrongCount = playerAnswers.length - correctCount
    const bonusCount = playerAnswers.filter((a: any) => a.was_only_correct).length

    const answerTimes = playerAnswers.map((a: any) => a.answer_time_ms).filter((t: any) => t != null)

    const avgTime =
      answerTimes.length > 0
        ? Math.round(answerTimes.reduce((sum, t) => sum + t, 0) / answerTimes.length)
        : 0

    const fastestTime = answerTimes.length > 0 ? Math.min(...answerTimes) : 0
    const slowestTime = answerTimes.length > 0 ? Math.max(...answerTimes) : 0

    return {
      userId: player.userId,
      playerName: player.playerName,
      totalScore: player.totalScore,
      correctAnswers: correctCount,
      wrongAnswers: wrongCount,
      bonusPoints: bonusCount,
      averageAnswerTimeMs: avgTime,
      fastestAnswerMs: fastestTime,
      slowestAnswerMs: slowestTime,
    }
  })

  // Sort by score descending
  stats.sort((a, b) => b.totalScore - a.totalScore)

  return stats
}

// Get answers for current question
export async function getQuestionAnswers(
  roomId: string,
  questionIndex: number
): Promise<ReverseAnswer[]> {
  const { data, error } = await supabase
    .from('vocab_reverse_answers')
    .select('*')
    .eq('room_id', roomId)
    .eq('question_index', questionIndex)

  if (error) throw error

  return (data || []).map((a: any) => ({
    id: a.id,
    userId: a.user_id,
    selectedWordId: a.selected_word_id,
    isCorrect: a.is_correct,
    wasOnlyCorrect: a.was_only_correct,
    pointsEarned: a.points_earned,
    answerTimeMs: a.answer_time_ms,
  }))
}

// Update room
export async function updateReverseRoom(
  roomId: string,
  updates: Partial<{
    status: ReverseRoomStatus
    currentQuestionIndex: number
    currentQuestion: Question | null
    questionStartTime: string | null
  }>
): Promise<void> {
  const dbUpdates: any = {
    updated_at: new Date().toISOString(),
  }

  if (updates.status !== undefined) dbUpdates.status = updates.status
  if (updates.currentQuestionIndex !== undefined)
    dbUpdates.current_question_index = updates.currentQuestionIndex
  if (updates.currentQuestion !== undefined) dbUpdates.current_question = updates.currentQuestion
  if (updates.questionStartTime !== undefined)
    dbUpdates.question_start_time = updates.questionStartTime

  const { error } = await (supabase as any).from('vocab_reverse_rooms').update(dbUpdates).eq('id', roomId)

  if (error) throw error
}

// Delete room
export async function deleteReverseRoom(roomId: string): Promise<void> {
  const { error } = await (supabase as any).from('vocab_reverse_rooms').delete().eq('id', roomId)

  if (error) throw error
}

// Subscribe to room updates
export function subscribeToReverseRoom(
  roomId: string,
  callback: (room: ReverseRoom) => void
): RealtimeChannel {
  const channel = supabase
    .channel(`reverse-room-${roomId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'vocab_reverse_rooms',
        filter: `id=eq.${roomId}`,
      },
      async () => {
        // Fetch full room data with players
        const room = await getReverseRoom(roomId)
        if (room) callback(room)
      }
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'vocab_reverse_players',
        filter: `room_id=eq.${roomId}`,
      },
      async () => {
        // Player joined/left - refresh room
        const room = await getReverseRoom(roomId)
        if (room) callback(room)
      }
    )
    .subscribe()

  return channel
}

// Helper mapper
function mapRoomFromDb(roomData: any, playersData: any[]): ReverseRoom {
  let gameWords = roomData.game_words || []
  let currentQuestion = roomData.current_question || null

  // Handle JSONB parsing
  if (typeof gameWords === 'string') {
    try {
      gameWords = JSON.parse(gameWords)
    } catch {
      gameWords = []
    }
  }
  if (typeof currentQuestion === 'string') {
    try {
      currentQuestion = JSON.parse(currentQuestion)
    } catch {
      currentQuestion = null
    }
  }

  return {
    id: roomData.id,
    roomCode: roomData.room_code,
    hostId: roomData.host_id,
    status: roomData.status,
    totalQuestions: roomData.total_questions,
    currentQuestionIndex: roomData.current_question_index,
    currentQuestion,
    gameWords: Array.isArray(gameWords) ? gameWords : [],
    questionStartTime: roomData.question_start_time,
    questionDurationMs: roomData.question_duration_ms,
    players: playersData.map((p) => ({
      id: p.id,
      userId: p.user_id,
      playerName: p.player_name,
      joinOrder: p.join_order,
      totalScore: p.total_score,
      isConnected: p.is_connected,
    })),
    createdAt: roomData.created_at,
    updatedAt: roomData.updated_at,
  }
}
