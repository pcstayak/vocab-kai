export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export interface Database {
  public: {
    Tables: {
      vocab_users: {
        Row: {
          id: string
          name: string
          created_at: string
        }
        Insert: {
          id?: string
          name: string
          created_at?: string
        }
        Update: {
          id?: string
          name?: string
          created_at?: string
        }
      }
      vocab_words: {
        Row: {
          id: string
          word: string
          hint: string
          definition: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          word: string
          hint?: string
          definition?: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          word?: string
          hint?: string
          definition?: string
          created_at?: string
          updated_at?: string
        }
      }
      vocab_user_progress: {
        Row: {
          id: string
          user_id: string
          word_id: string
          level_id: number
          streak_correct: number
          total_right: number
          total_wrong: number
          last_reviewed_at: string | null
          due_at: string
          last_result: 'right' | 'wrong' | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          word_id: string
          level_id?: number
          streak_correct?: number
          total_right?: number
          total_wrong?: number
          last_reviewed_at?: string | null
          due_at?: string
          last_result?: 'right' | 'wrong' | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          word_id?: string
          level_id?: number
          streak_correct?: number
          total_right?: number
          total_wrong?: number
          last_reviewed_at?: string | null
          due_at?: string
          last_result?: 'right' | 'wrong' | null
          created_at?: string
          updated_at?: string
        }
      }
      vocab_app_config: {
        Row: {
          id: string
          config_json: Json
          updated_at: string
        }
        Insert: {
          id?: string
          config_json: Json
          updated_at?: string
        }
        Update: {
          id?: string
          config_json?: Json
          updated_at?: string
        }
      }
    }
    Functions: {
      vocab_create_user_with_progress: {
        Args: { user_name: string }
        Returns: string
      }
      vocab_create_word_for_all_users: {
        Args: {
          word_text: string
          hint_text: string
          definition_text: string
        }
        Returns: string
      }
    }
  }
}
