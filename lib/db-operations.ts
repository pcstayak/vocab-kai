import { supabase, CONFIG_ID } from './supabase'
import type { SoundsConfig } from './sound-types'

// Types matching the app's data model
export type AppConfig = {
  levels: LevelConfig[]
  wrongMakesImmediatelyDue: boolean
  wrongResetsStreak: boolean
  sounds?: SoundsConfig
}

export type LevelConfig = {
  id: number
  name: string
  promoteAfterCorrect: number
  intervalDays: number
}

export type WordItem = {
  id: string
  word: string
  hint: string
  definition: string
  createdAt: string
  updatedAt: string
  levelId: number
  streakCorrect: number
  totalRight: number
  totalWrong: number
  lastReviewedAt?: string
  dueAt: string
  lastResult?: 'right' | 'wrong'
}

export type User = {
  id: string
  name: string
  created_at: string
}

// ============ User Operations ============

export async function getAllUsers(): Promise<User[]> {
  const { data, error } = await supabase
    .from('vocab_users')
    .select('*')
    .order('created_at', { ascending: true })

  if (error) throw error
  return data || []
}

export async function getUser(userId: string): Promise<User | null> {
  const { data, error } = await supabase
    .from('vocab_users')
    .select('*')
    .eq('id', userId)
    .single()

  if (error) {
    if (error.code === 'PGRST116') return null // Not found
    throw error
  }
  return data
}

export async function createUser(name: string): Promise<string> {
  // Type assertion needed due to Supabase RPC typing limitations
  const { data, error } = await supabase.rpc(
    'vocab_create_user_with_progress' as any,
    { user_name: name } as any
  )

  if (error) throw error
  return data as string
}

// ============ Config Operations ============

export async function getConfig(): Promise<AppConfig> {
  const { data, error } = await supabase
    .from('vocab_app_config')
    .select('config_json')
    .eq('id', CONFIG_ID)
    .single()

  if (error) throw error
  return (data as any).config_json as AppConfig
}

export async function updateConfig(config: AppConfig): Promise<void> {
  const { error } = await (supabase as any)
    .from('vocab_app_config')
    .update({ config_json: config })
    .eq('id', CONFIG_ID)

  if (error) throw error
}

// ============ Word Operations ============

export async function getAllWordsWithProgress(userId: string): Promise<WordItem[]> {
  const { data, error } = await supabase
    .from('vocab_words')
    .select(`
      *,
      vocab_user_progress!inner(
        level_id,
        streak_correct,
        total_right,
        total_wrong,
        last_reviewed_at,
        due_at,
        last_result
      )
    `)
    .eq('vocab_user_progress.user_id', userId)
    .order('word', { ascending: true })

  if (error) throw error

  // Map database structure to WordItem format
  return (data || []).map((word: any) => ({
    id: word.id,
    word: word.word,
    hint: word.hint,
    definition: word.definition,
    createdAt: word.created_at,
    updatedAt: word.updated_at,
    levelId: word.vocab_user_progress[0]?.level_id || 1,
    streakCorrect: word.vocab_user_progress[0]?.streak_correct || 0,
    totalRight: word.vocab_user_progress[0]?.total_right || 0,
    totalWrong: word.vocab_user_progress[0]?.total_wrong || 0,
    lastReviewedAt: word.vocab_user_progress[0]?.last_reviewed_at || undefined,
    dueAt: word.vocab_user_progress[0]?.due_at || new Date().toISOString(),
    lastResult: word.vocab_user_progress[0]?.last_result || undefined,
  }))
}

export async function createWord(
  word: string,
  hint: string,
  definition: string
): Promise<string> {
  // Type assertion needed due to Supabase RPC typing limitations
  const { data, error } = await supabase.rpc(
    'vocab_create_word_for_all_users' as any,
    {
      word_text: word,
      hint_text: hint,
      definition_text: definition,
    } as any
  )

  if (error) throw error
  return data as string
}

export async function updateWord(
  wordId: string,
  word: string,
  hint: string,
  definition: string
): Promise<void> {
  const { error } = await (supabase as any)
    .from('vocab_words')
    .update({ word, hint, definition })
    .eq('id', wordId)

  if (error) throw error
}

export async function deleteWord(wordId: string): Promise<void> {
  // Cascade delete will handle vocab_user_progress automatically
  const { error } = await (supabase as any)
    .from('vocab_words')
    .delete()
    .eq('id', wordId)

  if (error) throw error
}

// ============ Progress Operations ============

export async function updateProgress(
  userId: string,
  wordId: string,
  progress: {
    levelId: number
    streakCorrect: number
    totalRight: number
    totalWrong: number
    lastReviewedAt: string
    dueAt: string
    lastResult: 'right' | 'wrong'
  }
): Promise<void> {
  const { error } = await (supabase as any)
    .from('vocab_user_progress')
    .update({
      level_id: progress.levelId,
      streak_correct: progress.streakCorrect,
      total_right: progress.totalRight,
      total_wrong: progress.totalWrong,
      last_reviewed_at: progress.lastReviewedAt,
      due_at: progress.dueAt,
      last_result: progress.lastResult,
    })
    .eq('user_id', userId)
    .eq('word_id', wordId)

  if (error) throw error
}

export async function setWordLevel(
  userId: string,
  wordId: string,
  levelId: number
): Promise<void> {
  const { error } = await (supabase as any)
    .from('vocab_user_progress')
    .update({
      level_id: levelId,
      streak_correct: 0,
      due_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .eq('word_id', wordId)

  if (error) throw error
}

// ============ Due Words Query ============

export async function getDueWords(userId: string): Promise<WordItem[]> {
  const now = new Date().toISOString()

  const { data, error } = await supabase
    .from('vocab_user_progress')
    .select(`
      *,
      word:vocab_words(*)
    `)
    .eq('user_id', userId)
    .lte('due_at', now)
    .order('due_at', { ascending: true })

  if (error) throw error

  // Map to WordItem format
  return (data || []).map((progress: any) => ({
    id: progress.word.id,
    word: progress.word.word,
    hint: progress.word.hint,
    definition: progress.word.definition,
    createdAt: progress.word.created_at,
    updatedAt: progress.word.updated_at,
    levelId: progress.level_id,
    streakCorrect: progress.streak_correct,
    totalRight: progress.total_right,
    totalWrong: progress.total_wrong,
    lastReviewedAt: progress.last_reviewed_at || undefined,
    dueAt: progress.due_at,
    lastResult: progress.last_result || undefined,
  }))
}
