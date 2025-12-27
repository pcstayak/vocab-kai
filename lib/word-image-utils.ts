import { supabase } from './supabase'

const WORD_IMAGES_BUCKET = 'vocab-word-images'

// Upload word image to Supabase storage
export async function uploadWordImage(wordId: string, file: File): Promise<string> {
  // Validate file size (5MB limit)
  if (file.size > 5 * 1024 * 1024) {
    throw new Error('File size must be under 5MB')
  }

  // Validate file type
  const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
  if (!validTypes.includes(file.type)) {
    throw new Error('File must be an image (JPG, PNG, GIF, or WebP)')
  }

  // Generate filename: {wordId}/{timestamp}.{ext}
  const ext = file.name.split('.').pop() || 'jpg'
  const timestamp = Date.now()
  const path = `${wordId}/${timestamp}.${ext}`

  // Upload to Supabase storage
  const { data, error } = await (supabase as any).storage
    .from(WORD_IMAGES_BUCKET)
    .upload(path, file, {
      cacheControl: '3600',
      upsert: true,
    })

  if (error) throw error
  if (!data) throw new Error('Upload failed')

  // Get public URL
  const { data: urlData } = supabase.storage
    .from(WORD_IMAGES_BUCKET)
    .getPublicUrl(data.path)

  return urlData.publicUrl
}

// Delete word image from storage
export async function deleteWordImage(imageUrl: string): Promise<void> {
  try {
    // Extract path from URL
    const url = new URL(imageUrl)
    const pathMatch = url.pathname.match(/\/storage\/v1\/object\/public\/vocab-word-images\/(.+)/)

    if (!pathMatch) {
      console.warn('Could not extract path from image URL:', imageUrl)
      return
    }

    const path = pathMatch[1]
    const { error } = await (supabase as any).storage
      .from(WORD_IMAGES_BUCKET)
      .remove([path])

    if (error) throw error
  } catch (err) {
    console.error('Failed to delete image:', err)
    // Don't throw - allow word deletion to continue even if image deletion fails
  }
}
