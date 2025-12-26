# Spaced Repetition Vocab Trainer - Multi-User Edition

A vocabulary trainer using spaced repetition for effective learning. Built with Next.js, React, Tailwind CSS, and Supabase for cloud storage.

## Features

- ✅ **Multi-User Support**: Multiple family members can use the app with their own progress
- ✅ **Shared Vocabulary**: Everyone learns the same words, but at their own pace
- ✅ **Cloud Storage**: Data syncs automatically across devices via Supabase
- ✅ 3 pages in one app: Practice, Words, Settings
- ✅ Configurable levels, promotion requirements, and review intervals
- ✅ Practice queue that repeats "wrong" items in-session
- ✅ Scheduling with due dates (daily/weekly/monthly by default, configurable)
- ✅ Simple user management: Just enter a name to get started (no passwords)

## Getting Started

### Prerequisites

1. **Supabase Account**: Sign up at [supabase.com](https://supabase.com)
2. **Node.js**: Version 18 or higher

### Installation

```bash
npm install
```

### Supabase Setup

1. **Create a new Supabase project**:
   - Go to [https://app.supabase.com](https://app.supabase.com)
   - Click "New Project"
   - Choose a name and database password
   - Wait for the project to be created

2. **Run the database migration**:
   - In your Supabase project, go to the "SQL Editor"
   - Copy the contents of `supabase/migrations/001_initial_schema.sql`
   - Paste and run the SQL script
   - This creates all tables, functions, and seed data

3. **Get your API credentials**:
   - Go to Project Settings > API
   - Copy the "Project URL" and "anon public" key

4. **Configure environment variables**:
   - Update `.env.local` with your Supabase credentials:
   ```bash
   NEXT_PUBLIC_SUPABASE_URL=your-project-url-here
   NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
   ```

### Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the app.

### Build

```bash
npm run build
npm start
```

## Deployment to Vercel

1. Push your code to a GitHub repository
2. Go to [Vercel](https://vercel.com)
3. Click "New Project"
4. Import your GitHub repository
5. Vercel will automatically detect Next.js and configure the build settings
6. Click "Deploy"

Alternatively, you can use the Vercel CLI:

```bash
npm install -g vercel
vercel
```

## How It Works

### Learning System
- Only due cards show up in practice
- Wrong answers repeat again during the same session
- Correct answers increase streak; when streak hits the level threshold, the card promotes
- Intervals and thresholds are configurable in Settings (shared across all users)

### Multi-User Features
- **Shared Vocabulary**: When anyone adds a word, it automatically appears for all users
- **Individual Progress**: Each user has their own learning stats, levels, and due dates
- **Simple User Switching**: Click "Switch User" in the header to change users
- **No Authentication**: Just enter a name to create a user - perfect for family use

## Database Architecture

- **Supabase** (PostgreSQL) for cloud storage
- **users** table: Stores user profiles (just name and ID)
- **words** table: Shared vocabulary accessible to all users
- **user_progress** table: Per-user learning progress for each word
- **app_config** table: Shared SRS configuration (levels, intervals)

Data syncs automatically across all devices!

## License

Open source - feel free to use and modify!
