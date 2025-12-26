// Sound event types
export type SoundEvent =
  | 'cardRevealed'
  | 'rightAnswer'
  | 'wrongAnswer'
  | 'gameEnd'
  | 'winnerRevealed'

// Sound source configuration - all sounds stored in Supabase Storage
export type SoundSource =
  | {
      mode: 'none'
    }
  | {
      mode: 'single'
      path: string // Storage path, e.g., 'cardRevealed/swoosh.mp3'
    }
  | {
      mode: 'random'
      paths: string[] // Array of storage paths to randomly choose from
    }

// Complete sound configuration
export type SoundsConfig = {
  enabled: boolean
  volume: number // 0-100
  sounds: {
    cardRevealed: SoundSource
    rightAnswer: SoundSource
    wrongAnswer: SoundSource
    gameEnd: SoundSource
    winnerRevealed: SoundSource
  }
}

// Default configuration - starts with no sounds
export const defaultSoundsConfig: SoundsConfig = {
  enabled: true,
  volume: 70,
  sounds: {
    cardRevealed: { mode: 'none' },
    rightAnswer: { mode: 'none' },
    wrongAnswer: { mode: 'none' },
    gameEnd: { mode: 'none' },
    winnerRevealed: { mode: 'none' },
  },
}

// Suggested sound file names for initial upload (admin reference)
export const suggestedSoundNames: Record<SoundEvent, string[]> = {
  cardRevealed: ['swoosh', 'pop', 'chime'],
  rightAnswer: ['ding', 'bell', 'chime', 'success', 'yay', 'tada'],
  wrongAnswer: ['fart', 'wee', 'oops', 'buzzer', 'fail', 'boing'],
  gameEnd: ['chime', 'bell', 'ding', 'tada'],
  winnerRevealed: ['bell', 'chime', 'tada'],
}

// Human-readable labels for events
export const eventLabels: Record<SoundEvent, string> = {
  cardRevealed: 'Card Revealed',
  rightAnswer: 'Right Answer',
  wrongAnswer: 'Wrong Answer',
  gameEnd: 'Game End',
  winnerRevealed: 'Winner Revealed',
}
