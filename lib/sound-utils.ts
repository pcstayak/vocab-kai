import { supabase } from './supabase'
import type { SoundEvent, SoundSource, SoundsConfig } from './sound-types'

// Storage bucket name
const SOUNDS_BUCKET = 'vocab-sounds'

// Audio context for managing playback
class SoundPlayer {
  private audioElements: Map<string, HTMLAudioElement> = new Map()
  private config: SoundsConfig | null = null

  setConfig(config: SoundsConfig) {
    this.config = config
  }

  async play(event: SoundEvent) {
    if (!this.config || !this.config.enabled) return

    const soundSource = this.config.sounds[event]
    if (!soundSource || soundSource.mode === 'none') return

    try {
      const url = await this.getSoundUrl(soundSource)
      if (!url) return

      // Reuse or create audio element
      let audio = this.audioElements.get(url)
      if (!audio) {
        audio = new Audio(url)
        this.audioElements.set(url, audio)
      }

      audio.volume = this.config.volume / 100
      audio.currentTime = 0
      await audio.play()
    } catch (error) {
      console.error(`Failed to play sound for ${event}:`, error)
      // Fail silently - don't interrupt user experience
    }
  }

  private async getSoundUrl(source: SoundSource): Promise<string | null> {
    if (source.mode === 'none') {
      return null
    }

    if (source.mode === 'single') {
      return this.getPublicUrl(source.path)
    }

    if (source.mode === 'random') {
      if (source.paths.length === 0) return null
      // Randomly select one sound from the pool
      const randomIndex = Math.floor(Math.random() * source.paths.length)
      const randomPath = source.paths[randomIndex]
      return this.getPublicUrl(randomPath)
    }

    return null
  }

  private getPublicUrl(path: string): string | null {
    const { data } = supabase.storage.from(SOUNDS_BUCKET).getPublicUrl(path)
    return data?.publicUrl || null
  }

  // Preload sounds for better performance
  async preload(config: SoundsConfig) {
    this.setConfig(config)

    for (const event of Object.keys(config.sounds) as SoundEvent[]) {
      const source = config.sounds[event]

      if (source.mode === 'single') {
        const url = this.getPublicUrl(source.path)
        if (url && !this.audioElements.has(url)) {
          const audio = new Audio(url)
          this.audioElements.set(url, audio)
        }
      } else if (source.mode === 'random') {
        // Preload all sounds in the random pool
        for (const path of source.paths) {
          const url = this.getPublicUrl(path)
          if (url && !this.audioElements.has(url)) {
            const audio = new Audio(url)
            this.audioElements.set(url, audio)
          }
        }
      }
    }
  }
}

// Singleton instance
export const soundPlayer = new SoundPlayer()

// List all available sounds from storage for a specific event
export async function listAvailableSounds(event: SoundEvent): Promise<string[]> {
  try {
    const { data, error } = await supabase.storage.from(SOUNDS_BUCKET).list(event, {
      limit: 100,
      offset: 0,
    })

    if (error) throw error

    // Return full paths like 'cardRevealed/swoosh.mp3'
    return (data || [])
      .filter((file) => file.name.endsWith('.mp3') || file.name.endsWith('.wav') || file.name.endsWith('.ogg'))
      .map((file) => `${event}/${file.name}`)
  } catch (error) {
    console.error(`Failed to list sounds for ${event}:`, error)
    return []
  }
}

// List all sounds across all events
export async function listAllSounds(): Promise<Record<SoundEvent, string[]>> {
  const events: SoundEvent[] = ['cardRevealed', 'rightAnswer', 'wrongAnswer', 'gameEnd', 'winnerRevealed']

  const results = await Promise.all(events.map((event) => listAvailableSounds(event)))

  return {
    cardRevealed: results[0],
    rightAnswer: results[1],
    wrongAnswer: results[2],
    gameEnd: results[3],
    winnerRevealed: results[4],
  }
}

// Upload custom sound to Supabase storage
export async function uploadSound(event: SoundEvent, file: File): Promise<string> {
  // Validate file size (2MB limit)
  if (file.size > 2 * 1024 * 1024) {
    throw new Error('File size must be under 2MB')
  }

  // Validate file type
  const validTypes = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp3']
  if (!validTypes.includes(file.type)) {
    throw new Error('File must be an audio file (MP3, WAV, or OGG)')
  }

  // Generate filename: event/name.mp3
  const sanitizedName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_')
  const path = `${event}/${sanitizedName}`

  // Upload to Supabase storage
  const { data, error } = await (supabase as any).storage
    .from(SOUNDS_BUCKET)
    .upload(path, file, {
      cacheControl: '3600',
      upsert: true, // Allow overwriting
    })

  if (error) throw error
  if (!data) throw new Error('Upload failed')

  return data.path
}

// Download sound from URL and reupload to storage
export async function uploadSoundFromUrl(event: SoundEvent, url: string): Promise<string> {
  // Fetch the audio file
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error('Failed to download audio file from URL')
  }

  // Convert to blob
  const blob = await response.blob()

  // Validate size
  if (blob.size > 2 * 1024 * 1024) {
    throw new Error('File size must be under 2MB')
  }

  // Extract filename from URL
  const urlPath = new URL(url).pathname
  const filename = urlPath.split('/').pop() || 'sound.mp3'

  // Create File object
  const file = new File([blob], filename, { type: blob.type })

  return uploadSound(event, file)
}

// Delete sound from storage
export async function deleteSound(path: string): Promise<void> {
  const { error } = await (supabase as any).storage.from(SOUNDS_BUCKET).remove([path])

  if (error) throw error
}

// Preview sound (play once without saving)
export async function previewSound(source: SoundSource, volume: number) {
  const player = new SoundPlayer()
  player.setConfig({
    enabled: true,
    volume,
    sounds: {
      cardRevealed: source,
      rightAnswer: source,
      wrongAnswer: source,
      gameEnd: source,
      winnerRevealed: source,
    },
  })

  await player.play('cardRevealed')
}
