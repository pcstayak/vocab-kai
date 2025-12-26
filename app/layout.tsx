import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Spaced Repetition Vocab Trainer',
  description: 'A vocabulary trainer using spaced repetition for effective learning',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
