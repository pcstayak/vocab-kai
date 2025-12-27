-- Migration 004: Add image support for word hints

-- Add image_url column to vocab_words table
ALTER TABLE vocab_words
ADD COLUMN IF NOT EXISTS image_url TEXT;

-- Create storage bucket for word images
INSERT INTO storage.buckets (id, name, public)
VALUES ('vocab-word-images', 'vocab-word-images', true)
ON CONFLICT (id) DO NOTHING;

-- RLS policies for word images
DO $$
BEGIN
  -- Public read access
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
    AND tablename = 'objects'
    AND policyname = 'Public read access for word images'
  ) THEN
    CREATE POLICY "Public read access for word images"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'vocab-word-images');
  END IF;

  -- Authenticated users can upload
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
    AND tablename = 'objects'
    AND policyname = 'Authenticated users can upload word images'
  ) THEN
    CREATE POLICY "Authenticated users can upload word images"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (bucket_id = 'vocab-word-images');
  END IF;

  -- Authenticated users can delete
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
    AND tablename = 'objects'
    AND policyname = 'Users can delete word images'
  ) THEN
    CREATE POLICY "Users can delete word images"
    ON storage.objects FOR DELETE
    TO authenticated
    USING (bucket_id = 'vocab-word-images');
  END IF;
END $$;
