/*
Spaced Repetition Vocab Trainer — Multi-user Next.js (App Router) app with Supabase.

✅ What you get:
- 3 pages in one file (tabs): Practice, Words, Settings
- Cloud persistence via Supabase (words, progress per user, global config)
- Multi-user support with per-user progress tracking
- Text-to-speech pronunciation using Web Speech API
- Configurable levels, promotion requirements, review intervals
- Practice queue that repeats "wrong" items in-session
- Scheduling that uses due dates (daily/weekly/monthly by default, configurable)
- Import/Export JSON for backup

⚠️ How to use on Vercel (Next.js + Tailwind + Supabase):
- Create a Next.js app (App Router)
- Set up Supabase project and configure environment variables
- Run database migrations to create tables
- Deploy to Vercel

Cloud storage powered by Supabase. Data syncs across devices.
*/

'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import UserSelector from '../components/UserSelector'
import {
  getConfig,
  updateConfig,
  getAllWordsWithProgress,
  createWord as dbCreateWord,
  updateWord as dbUpdateWord,
  deleteWord as dbDeleteWord,
  updateProgress,
  setWordLevel as dbSetWordLevel,
  type AppConfig as DbAppConfig,
  type WordItem as DbWordItem,
} from '../lib/db-operations'

// ---------------- Types ----------------

type ISODateString = string

type LevelConfig = {
  id: number
  name: string
  // How many consecutive correct answers are required to promote OUT of this level
  promoteAfterCorrect: number
  // How long until the item is due again after a correct answer at this level
  intervalDays: number
}

type AppConfig = {
  levels: LevelConfig[]
  // Optional: if true, wrong answers make the card immediately due again (today)
  wrongMakesImmediatelyDue: boolean
  // If true, a wrong answer resets the consecutive correct streak for the current level
  wrongResetsStreak: boolean
}

type WordItem = {
  id: string
  word: string
  hint: string
  definition: string
  createdAt: ISODateString
  updatedAt: ISODateString

  // Learning state
  levelId: number // corresponds to LevelConfig.id
  streakCorrect: number // consecutive correct in current level
  totalRight: number
  totalWrong: number
  lastReviewedAt?: ISODateString
  dueAt: ISODateString
  // Last result: useful for quick visual
  lastResult?: 'right' | 'wrong'
}

type AppData = {
  version: number
  config: AppConfig
  words: WordItem[]
}

// ---------------- Defaults ----------------

const STORAGE_KEY = 'srs_vocab_trainer_v1'

const defaultConfig: AppConfig = {
  levels: [
    { id: 1, name: 'Level 1', promoteAfterCorrect: 3, intervalDays: 1 },
    { id: 2, name: 'Level 2', promoteAfterCorrect: 2, intervalDays: 7 },
    { id: 3, name: 'Level 3', promoteAfterCorrect: 1, intervalDays: 30 },
  ],
  wrongMakesImmediatelyDue: true,
  wrongResetsStreak: true,
}

const defaultData: AppData = {
  version: 1,
  config: defaultConfig,
  words: [],
}

// ---------------- Utilities ----------------

function todayStartLocal(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

function toISO(d: Date): ISODateString {
  return d.toISOString()
}

function parseISO(s: string): Date {
  return new Date(s)
}

function uuid(): string {
  // RFC4122-ish, fine for local IDs
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function clampInt(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function safeJsonParse<T>(s: string | null): T | null {
  if (!s) return null
  try {
    return JSON.parse(s) as T
  } catch {
    return null
  }
}

function sortByDueThenUpdated(a: WordItem, b: WordItem) {
  const da = parseISO(a.dueAt).getTime()
  const db = parseISO(b.dueAt).getTime()
  if (da !== db) return da - db
  return parseISO(b.updatedAt).getTime() - parseISO(a.updatedAt).getTime()
}

function isDue(item: WordItem, now = new Date()): boolean {
  return parseISO(item.dueAt).getTime() <= now.getTime()
}

function formatShortDate(iso?: string): string {
  if (!iso) return '—'
  const d = parseISO(iso)
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' })
}

function formatShortDateTime(iso?: string): string {
  if (!iso) return '—'
  const d = parseISO(iso)
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// ---------------- Main Component ----------------

type Tab = 'practice' | 'words' | 'settings'

export default function Page() {
  const [tab, setTab] = useState<Tab>('practice')

  // User selection state
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [loadingUser, setLoadingUser] = useState(true)

  const [data, setData] = useState<AppData>(defaultData)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)

  // Practice state
  const [practiceMode, setPracticeMode] = useState(false)
  const [showHint, setShowHint] = useState(false)
  const [showDef, setShowDef] = useState(false)
  const [sessionWrongPool, setSessionWrongPool] = useState<string[]>([]) // word IDs to re-ask
  const [sessionSeenCount, setSessionSeenCount] = useState(0)
  const [sessionRightCount, setSessionRightCount] = useState(0)
  const [sessionWrongCount, setSessionWrongCount] = useState(0)

  // Current card id for practice
  const [currentId, setCurrentId] = useState<string | null>(null)

  // Words editor state
  const [editId, setEditId] = useState<string | null>(null)
  const [draftWord, setDraftWord] = useState('')
  const [draftHint, setDraftHint] = useState('')
  const [draftDef, setDraftDef] = useState('')
  const [search, setSearch] = useState('')

  // Settings state
  const [configDraft, setConfigDraft] = useState<AppConfig>(defaultConfig)
  const [importText, setImportText] = useState('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // ---------------- Load / Save ----------------

  // Check for saved user ID on mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const savedUserId = localStorage.getItem('selectedUserId')
      if (savedUserId) {
        setCurrentUserId(savedUserId)
      }
    }
    setLoadingUser(false)
  }, [])

  // Load data from Supabase when user is selected
  useEffect(() => {
    if (!currentUserId) {
      setLoaded(true)
      return
    }

    async function loadUserData() {
      // We've already checked currentUserId is not null above
      if (!currentUserId) return

      try {
        setLoadError(null)
        setLoaded(false)

        // Load config and words in parallel
        const [config, words] = await Promise.all([
          getConfig(),
          getAllWordsWithProgress(currentUserId),
        ])

        setData({
          version: 1,
          config,
          words,
        })
        setConfigDraft(config)
        setLoaded(true)
      } catch (error) {
        console.error('Error loading user data:', error)
        setLoadError('Failed to load data from Supabase. Please check your connection.')
        setLoaded(true)
      }
    }

    loadUserData()
  }, [currentUserId])

  // ---------------- Derived ----------------

  const levelMap = useMemo(() => {
    const m = new Map<number, LevelConfig>()
    for (const lvl of data.config.levels) m.set(lvl.id, lvl)
    return m
  }, [data.config.levels])

  const now = useMemo(() => new Date(), [tab, practiceMode, currentId, data.words.length])

  const dueWords = useMemo(() => {
    const list = data.words.filter((w) => isDue(w, now))
    list.sort(sortByDueThenUpdated)
    return list
  }, [data.words, now])

  const notDueCount = useMemo(() => data.words.length - dueWords.length, [data.words.length, dueWords.length])

  const currentWord: WordItem | null = useMemo(() => {
    if (!currentId) return null
    return data.words.find((w) => w.id === currentId) ?? null
  }, [currentId, data.words])

  const filteredWords = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return [...data.words].sort((a, b) => a.word.localeCompare(b.word))
    return data.words
      .filter((w) =>
        [w.word, w.hint, w.definition].some((s) => (s || '').toLowerCase().includes(q))
      )
      .sort((a, b) => a.word.localeCompare(b.word))
  }, [data.words, search])

  const stats = useMemo(() => {
    const total = data.words.length
    const due = dueWords.length
    const maxLevelId = Math.max(...data.config.levels.map((l) => l.id))
    const byLevel: Record<number, number> = {}
    for (const lvl of data.config.levels) byLevel[lvl.id] = 0
    for (const w of data.words) byLevel[w.levelId] = (byLevel[w.levelId] ?? 0) + 1

    const mastered = data.words.filter((w) => w.levelId === maxLevelId).length
    return { total, due, mastered, byLevel }
  }, [data.words, dueWords.length, data.config.levels])

  // ---------------- Practice Logic ----------------

  useEffect(() => {
    if (!practiceMode) return

    // Ensure current card exists; if not, pick next.
    if (!currentId) {
      const next = pickNextCardId({
        data,
        dueWords,
        sessionWrongPool,
      })
      setCurrentId(next)
      setShowHint(false)
      setShowDef(false)
      return
    }

    // If current became deleted, move on
    if (currentId && !data.words.some((w) => w.id === currentId)) {
      const next = pickNextCardId({
        data,
        dueWords,
        sessionWrongPool,
      })
      setCurrentId(next)
      setShowHint(false)
      setShowDef(false)
    }
  }, [practiceMode, currentId, data, dueWords, sessionWrongPool])

  function startPractice() {
    setPracticeMode(true)
    setSessionWrongPool([])
    setSessionSeenCount(0)
    setSessionRightCount(0)
    setSessionWrongCount(0)

    const next = pickNextCardId({ data, dueWords, sessionWrongPool: [] })
    setCurrentId(next)
    setShowHint(false)
    setShowDef(false)
  }

  function stopPractice() {
    setPracticeMode(false)
    setCurrentId(null)
    setShowHint(false)
    setShowDef(false)
    setSessionWrongPool([])
  }

  function pickNextAndResetViews(nextId: string | null) {
    setCurrentId(nextId)
    setShowHint(false)
    setShowDef(false)
  }

  async function answer(right: boolean) {
    if (!currentWord || !currentUserId) return

    const updated = applyAnswer({
      word: currentWord,
      right,
      config: data.config,
    })

    // Update word list optimistically
    setData((prev) => ({
      ...prev,
      words: prev.words.map((w) => (w.id === updated.id ? updated : w)),
    }))

    // Save progress to Supabase in background
    updateProgress(currentUserId, updated.id, {
      levelId: updated.levelId,
      streakCorrect: updated.streakCorrect,
      totalRight: updated.totalRight,
      totalWrong: updated.totalWrong,
      lastReviewedAt: updated.lastReviewedAt || toISO(new Date()),
      dueAt: updated.dueAt,
      lastResult: updated.lastResult!,
    }).catch((error) => {
      console.error('Error saving progress:', error)
      // Silently fail - don't interrupt practice flow
    })

    setSessionSeenCount((n) => n + 1)
    if (right) setSessionRightCount((n) => n + 1)
    else setSessionWrongCount((n) => n + 1)

    // Wrong -> add to sessionWrongPool (re-ask in same session)
    let nextWrongPool = sessionWrongPool
    if (!right) {
      if (!sessionWrongPool.includes(updated.id)) {
        nextWrongPool = [...sessionWrongPool, updated.id]
        setSessionWrongPool(nextWrongPool)
      }
    } else {
      // If answered right and it was in the wrong pool, remove it (so it stops repeating)
      if (sessionWrongPool.includes(updated.id)) {
        nextWrongPool = sessionWrongPool.filter((id) => id !== updated.id)
        setSessionWrongPool(nextWrongPool)
      }
    }

    // Pick next
    const next = pickNextCardId({
      data: { ...data, words: data.words.map((w) => (w.id === updated.id ? updated : w)) },
      dueWords,
      sessionWrongPool: nextWrongPool,
      // Avoid immediate repeat unless that's all we have
      avoidId: updated.id,
    })

    pickNextAndResetViews(next)
  }

  // ---------------- Word CRUD ----------------

  function resetDraft() {
    setEditId(null)
    setDraftWord('')
    setDraftHint('')
    setDraftDef('')
  }

  function beginEdit(w: WordItem) {
    setEditId(w.id)
    setDraftWord(w.word)
    setDraftHint(w.hint)
    setDraftDef(w.definition)
  }

  async function saveDraft() {
    const word = draftWord.trim()
    const hint = draftHint.trim()
    const definition = draftDef.trim()
    if (!word || !currentUserId) return

    const nowIso = toISO(new Date())

    try {
      if (editId) {
        // Update existing word
        await dbUpdateWord(editId, word, hint, definition)

        setData((prev) => ({
          ...prev,
          words: prev.words.map((w) =>
            w.id === editId
              ? {
                  ...w,
                  word,
                  hint,
                  definition,
                  updatedAt: nowIso,
                }
              : w
          ),
        }))
      } else {
        // Create new word (database function creates progress for all users)
        const newWordId = await dbCreateWord(word, hint, definition)

        const firstLevelId = prevSafeFirstLevelId(data.config)
        const item: WordItem = {
          id: newWordId,
          word,
          hint,
          definition,
          createdAt: nowIso,
          updatedAt: nowIso,
          levelId: firstLevelId,
          streakCorrect: 0,
          totalRight: 0,
          totalWrong: 0,
          dueAt: nowIso,
        }

        setData((prev) => ({
          ...prev,
          words: [...prev.words, normalizeWord(item, prev.config)],
        }))
      }

      resetDraft()
    } catch (error) {
      console.error('Error saving word:', error)
    }
  }

  async function deleteWord(id: string) {
    if (!currentUserId) return

    try {
      await dbDeleteWord(id)

      setData((prev) => ({
        ...prev,
        words: prev.words.filter((w) => w.id !== id),
      }))
      if (currentId === id) {
        setCurrentId(null)
      }
      if (editId === id) resetDraft()
      setSessionWrongPool((pool) => pool.filter((x) => x !== id))
    } catch (error) {
      console.error('Error deleting word:', error)
    }
  }

  async function setLevel(id: string, levelId: number) {
    const lvl = levelMap.get(levelId)
    if (!lvl || !currentUserId) return

    const nowIso = toISO(new Date())

    try {
      await dbSetWordLevel(currentUserId, id, levelId)

      setData((prev) => ({
        ...prev,
        words: prev.words.map((w) =>
          w.id === id
            ? {
                ...w,
                levelId,
                streakCorrect: 0,
                updatedAt: nowIso,
                dueAt: nowIso,
              }
            : w
        ),
      }))
    } catch (error) {
      console.error('Error updating word level:', error)
    }
  }

  // ---------------- Settings ----------------

  async function applySettings() {
    const normalized = normalizeConfig(configDraft)

    try {
      await updateConfig(normalized)

      setData((prev) => {
        const words = prev.words.map((w) => normalizeWord(w, normalized))
        return { ...prev, config: normalized, words }
      })
      setConfigDraft(normalized)
    } catch (error) {
      console.error('Error saving config:', error)
    }
  }

  function switchUser() {
    localStorage.removeItem('selectedUserId')
    setCurrentUserId(null)
    setData(defaultData)
    setLoaded(false)
    stopPractice()
    resetDraft()
  }

  function resetToDefaults() {
    setConfigDraft(defaultConfig)
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'srs_vocab_trainer_export.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  async function importJsonFromText() {
    if (!currentUserId || importing) return

    const parsed = safeJsonParse<AppData>(importText)
    if (!parsed || parsed.version !== 1 || !parsed.config || !Array.isArray(parsed.words)) {
      console.error('Import failed: invalid JSON or wrong format.')
      return
    }

    setImporting(true)

    try {
      const cfg = normalizeConfig(parsed.config)

      // Save config to database
      await updateConfig(cfg)

      // Get current words to check for existing ones
      const currentWords = await getAllWordsWithProgress(currentUserId)
      const wordMap = new Map(currentWords.map(w => [w.word.toLowerCase(), w]))

      // Import words - process them but don't update progress in the loop
      for (const w of parsed.words) {
        const normalized = normalizeWord(w, cfg)
        const existingWord = wordMap.get(normalized.word.toLowerCase())

        let wordId: string
        if (existingWord) {
          // Update existing word
          await dbUpdateWord(existingWord.id, normalized.word, normalized.hint, normalized.definition)
          wordId = existingWord.id
        } else {
          // Create new word (this automatically creates progress for ALL users via RPC function)
          wordId = await dbCreateWord(normalized.word, normalized.hint, normalized.definition)
        }

        // Update progress for current user to match imported values
        await updateProgress(currentUserId, wordId, {
          levelId: normalized.levelId,
          streakCorrect: normalized.streakCorrect,
          totalRight: normalized.totalRight,
          totalWrong: normalized.totalWrong,
          lastReviewedAt: normalized.lastReviewedAt || toISO(new Date()),
          dueAt: normalized.dueAt,
          lastResult: normalized.lastResult || 'right',
        })
      }

      // Reload data from database ONCE at the end
      const [config, words] = await Promise.all([
        getConfig(),
        getAllWordsWithProgress(currentUserId),
      ])

      setData({
        version: 1,
        config,
        words,
      })
      setConfigDraft(config)
      setImportText('')
    } catch (error) {
      console.error('Error importing data:', error)
    } finally {
      setImporting(false)
    }
  }

  async function importJsonFromFile(file: File) {
    const text = await file.text()
    setImportText(text)
  }

  async function wipeAllData() {
    if (!currentUserId) return

    if (!confirm('Reset all your progress? This cannot be undone.')) {
      return
    }

    try {
      // Reset config to defaults
      await updateConfig(defaultConfig)

      // Reset current user's progress for all words to Level 1
      const firstLevelId = defaultConfig.levels[0].id
      const nowIso = toISO(new Date())

      for (const word of data.words) {
        await updateProgress(currentUserId, word.id, {
          levelId: firstLevelId,
          streakCorrect: 0,
          totalRight: 0,
          totalWrong: 0,
          lastReviewedAt: nowIso,
          dueAt: nowIso,
          lastResult: 'right',
        })
      }

      // Reload data from database
      const [config, words] = await Promise.all([
        getConfig(),
        getAllWordsWithProgress(currentUserId),
      ])

      setData({
        version: 1,
        config,
        words,
      })
      setConfigDraft(config)
      stopPractice()
      resetDraft()
      setSearch('')
    } catch (error) {
      console.error('Error resetting progress:', error)
    }
  }

  // ---------------- UI ----------------

  // Show user selector if no user is selected
  if (loadingUser) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
        <div className="text-lg font-semibold">Loading...</div>
      </div>
    )
  }

  if (!currentUserId) {
    return <UserSelector onUserSelected={(userId) => setCurrentUserId(userId)} />
  }

  // Show error if data loading failed
  if (loadError) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
        <div className="max-w-md rounded-2xl border border-rose-900/40 bg-rose-950/20 p-6">
          <div className="mb-3 text-lg font-semibold text-rose-200">Error</div>
          <div className="mb-4 text-sm text-rose-200/80">{loadError}</div>
          <button
            onClick={() => setCurrentUserId(null)}
            className="rounded-xl bg-rose-400 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-rose-300"
          >
            Back to User Selection
          </button>
        </div>
      </div>
    )
  }

  // Show loading state while data is being fetched
  if (!loaded) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
        <div className="text-lg font-semibold">Loading your data...</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-5xl px-4 py-6">
        <Header
          tab={tab}
          setTab={(t) => {
            setTab(t)
            // Leaving practice resets session visuals but keeps progress
            if (t !== 'practice') {
              setShowHint(false)
              setShowDef(false)
            }
          }}
          stats={stats}
          dueNextHint={dueWords[0]?.dueAt}
          practiceMode={practiceMode}
          onStopPractice={stopPractice}
          onSwitchUser={switchUser}
        />

        <main className="mt-6">
          {tab === 'practice' && (
            <PracticeTab
              data={data}
              dueWords={dueWords}
              notDueCount={notDueCount}
              practiceMode={practiceMode}
              onStart={startPractice}
              onStop={stopPractice}
              currentWord={currentWord}
              showHint={showHint}
              showDef={showDef}
              setShowHint={setShowHint}
              setShowDef={setShowDef}
              onAnswer={answer}
              session={{
                seen: sessionSeenCount,
                right: sessionRightCount,
                wrong: sessionWrongCount,
                wrongPoolCount: sessionWrongPool.length,
              }}
              levelMap={levelMap}
            />
          )}

          {tab === 'words' && (
            <WordsTab
              data={data}
              levelMap={levelMap}
              search={search}
              setSearch={setSearch}
              editId={editId}
              draft={{ word: draftWord, hint: draftHint, def: draftDef }}
              setDraft={{
                setWord: setDraftWord,
                setHint: setDraftHint,
                setDef: setDraftDef,
              }}
              onBeginEdit={beginEdit}
              onCancelEdit={resetDraft}
              onSave={saveDraft}
              onDelete={deleteWord}
              onSetLevel={setLevel}
              words={filteredWords}
            />
          )}

          {tab === 'settings' && (
            <SettingsTab
              configDraft={configDraft}
              setConfigDraft={setConfigDraft}
              onApply={applySettings}
              onResetDefaults={resetToDefaults}
              exportJson={exportJson}
              importText={importText}
              setImportText={setImportText}
              importJsonFromText={importJsonFromText}
              importJsonFromFile={importJsonFromFile}
              wipeAllData={wipeAllData}
              fileInputRef={fileInputRef}
              importing={importing}
            />
          )}
        </main>

        <footer className="mt-10 border-t border-slate-800 pt-6 text-xs text-slate-400">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              Cloud storage powered by Supabase. Your data syncs automatically across devices.
            </div>
            <div>Version 2 • Multi-User • {new Date().getFullYear()}</div>
          </div>
        </footer>
      </div>
    </div>
  )
}

// ---------------- Components ----------------

function Header(props: {
  tab: Tab
  setTab: (t: Tab) => void
  stats: { total: number; due: number; mastered: number; byLevel: Record<number, number> }
  dueNextHint?: string
  practiceMode: boolean
  onStopPractice: () => void
  onSwitchUser: () => void
}) {
  const { tab, setTab, stats, dueNextHint, practiceMode, onStopPractice, onSwitchUser } = props

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-5 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-slate-800 text-slate-100">
            <span className="text-lg font-semibold">SRS</span>
          </div>
          <div>
            <div className="text-lg font-semibold leading-tight">Vocab Trainer</div>
            <div className="text-sm text-slate-300">
              Due today: <span className="font-medium text-slate-100">{stats.due}</span> • Total:{' '}
              <span className="font-medium text-slate-100">{stats.total}</span> • Mastered:{' '}
              <span className="font-medium text-slate-100">{stats.mastered}</span>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:items-end">
          <div className="flex gap-2">
            <TopTabButton active={tab === 'practice'} onClick={() => setTab('practice')}>
              Practice
            </TopTabButton>
            <TopTabButton active={tab === 'words'} onClick={() => setTab('words')}>
              Words
            </TopTabButton>
            <TopTabButton active={tab === 'settings'} onClick={() => setTab('settings')}>
              Settings
            </TopTabButton>
          </div>
          <div className="text-xs text-slate-400 flex items-center gap-2">
            <span>Next due: <span className="text-slate-200">{formatShortDateTime(dueNextHint)}</span></span>
            {practiceMode ? (
              <button
                className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-slate-200 hover:bg-slate-900"
                onClick={onStopPractice}
              >
                Stop session
              </button>
            ) : null}
            <button
              className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-slate-200 hover:bg-slate-900"
              onClick={onSwitchUser}
              title="Switch to a different user"
            >
              Switch User
            </button>
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {Object.entries(stats.byLevel).map(([k, v]) => (
          <div
            key={k}
            className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm"
          >
            <div className="text-slate-400">Level {k}</div>
            <div className="text-base font-semibold text-slate-100">{v}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function TopTabButton(props: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={props.onClick}
      className={
        'rounded-xl px-3 py-2 text-sm font-medium transition ' +
        (props.active
          ? 'bg-slate-100 text-slate-950'
          : 'border border-slate-700 bg-slate-950/40 text-slate-200 hover:bg-slate-900')
      }
    >
      {props.children}
    </button>
  )
}

function PracticeTab(props: {
  data: AppData
  dueWords: WordItem[]
  notDueCount: number
  practiceMode: boolean
  onStart: () => void
  onStop: () => void
  currentWord: WordItem | null
  showHint: boolean
  showDef: boolean
  setShowHint: React.Dispatch<React.SetStateAction<boolean>>
  setShowDef: React.Dispatch<React.SetStateAction<boolean>>
  onAnswer: (right: boolean) => void
  session: { seen: number; right: number; wrong: number; wrongPoolCount: number }
  levelMap: Map<number, LevelConfig>
}) {
  const {
    dueWords,
    notDueCount,
    practiceMode,
    onStart,
    onStop,
    currentWord,
    showHint,
    showDef,
    setShowHint,
    setShowDef,
    onAnswer,
    session,
    levelMap,
  } = props

  const lvl = currentWord ? levelMap.get(currentWord.levelId) : undefined

  return (
    <div className="grid gap-4">
      <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-5">
        {!practiceMode ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-lg font-semibold">Practice</div>
              <div className="mt-1 text-sm text-slate-300">
                Due now: <span className="font-medium text-slate-100">{dueWords.length}</span> • Not due:{' '}
                <span className="font-medium text-slate-100">{notDueCount}</span>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={onStart}
                className="rounded-xl bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-300"
              >
                Start session
              </button>
              <button
                onClick={onStop}
                className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-900"
              >
                Reset
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-lg font-semibold">Session</div>
              <div className="mt-1 text-sm text-slate-300">
                Seen: <span className="font-medium text-slate-100">{session.seen}</span> • Right:{' '}
                <span className="font-medium text-slate-100">{session.right}</span> • Wrong:{' '}
                <span className="font-medium text-slate-100">{session.wrong}</span> • Pending repeats:{' '}
                <span className="font-medium text-slate-100">{session.wrongPoolCount}</span>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={onStop}
                className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-900"
              >
                Stop
              </button>
            </div>
          </div>
        )}
      </div>

      {practiceMode ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-5">
          {!currentWord ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <div className="text-lg font-semibold">No cards due</div>
              <div className="max-w-md text-sm text-slate-300">
                You can add words in the Words tab, or wait until some cards become due.
              </div>
              <button
                onClick={onStop}
                className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-900"
              >
                End session
              </button>
            </div>
          ) : (
            <div className="grid gap-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm text-slate-300">
                  <Badge>{lvl?.name ?? `Level ${currentWord.levelId}`}</Badge>
                  <Badge>
                    Streak: {currentWord.streakCorrect}/{lvl?.promoteAfterCorrect ?? '—'}
                  </Badge>
                  <Badge>Due: {formatShortDate(currentWord.dueAt)}</Badge>
                </div>
                <div className="text-xs text-slate-400">
                  Last: {currentWord.lastResult ? currentWord.lastResult.toUpperCase() : '—'} • Reviewed:{' '}
                  {formatShortDateTime(currentWord.lastReviewedAt)}
                </div>
              </div>

              <div className="rounded-2xl border border-slate-800 bg-slate-950/50 p-6">
                <div className="text-center">
                  <div className="flex items-center justify-center gap-3">
                    <div className="text-3xl font-bold tracking-tight sm:text-4xl">{currentWord.word}</div>
                    <button
                      onClick={() => {
                        const utterance = new SpeechSynthesisUtterance(currentWord.word)
                        utterance.lang = 'en-US'
                        utterance.rate = 0.9
                        window.speechSynthesis.speak(utterance)
                      }}
                      className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-slate-200 hover:bg-slate-900"
                      title="Pronounce word"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                        strokeWidth={1.5}
                        stroke="currentColor"
                        className="w-6 h-6"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z"
                        />
                      </svg>
                    </button>
                  </div>
                </div>

                <div className="mt-6 grid gap-3">
                  <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-semibold">Hint</div>
                      <button
                        className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-900"
                        onClick={() => setShowHint((v) => !v)}
                      >
                        {showHint ? 'Hide' : 'Show hint'}
                      </button>
                    </div>
                    <div className="mt-2 text-sm text-slate-200">
                      {showHint ? (currentWord.hint || <span className="text-slate-500">(empty)</span>) : <span className="text-slate-500">Hidden</span>}
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-semibold">Definition</div>
                      <button
                        className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-900"
                        onClick={() => setShowDef((v) => !v)}
                      >
                        {showDef ? 'Hide' : 'Reveal'}
                      </button>
                    </div>
                    <div className="mt-2 text-sm text-slate-200">
                      {showDef ? (currentWord.definition || <span className="text-slate-500">(empty)</span>) : <span className="text-slate-500">Hidden</span>}
                    </div>
                  </div>
                </div>

                <div className="mt-6 flex flex-col gap-2 sm:flex-row">
                  <button
                    className="w-full rounded-xl bg-rose-400 px-4 py-3 text-sm font-semibold text-slate-950 hover:bg-rose-300"
                    onClick={() => onAnswer(false)}
                  >
                    Wrong
                  </button>
                  <button
                    className="w-full rounded-xl bg-emerald-400 px-4 py-3 text-sm font-semibold text-slate-950 hover:bg-emerald-300"
                    onClick={() => onAnswer(true)}
                  >
                    Right
                  </button>
                </div>

                <div className="mt-3 text-center text-xs text-slate-400">
                  Tip: you can answer without revealing hint/definition — this is manual self-grading.
                </div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 text-sm text-slate-300">
                <div className="flex flex-wrap gap-3">
                  <div>
                    Total right: <span className="font-semibold text-slate-100">{currentWord.totalRight}</span>
                  </div>
                  <div>
                    Total wrong: <span className="font-semibold text-slate-100">{currentWord.totalWrong}</span>
                  </div>
                  <div>
                    Next due: <span className="font-semibold text-slate-100">{formatShortDateTime(currentWord.dueAt)}</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-5">
          <div className="grid gap-2">
            <div className="text-sm text-slate-300">
              How it works:
              <ul className="ml-5 mt-1 list-disc text-slate-400">
                <li>Only due cards show up in practice.</li>
                <li>Wrong answers repeat again during the same session.</li>
                <li>Correct answers increase streak; when streak hits the level threshold, the card promotes.</li>
                <li>Intervals and thresholds are configurable in Settings.</li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-slate-700 bg-slate-950/60 px-3 py-1 text-xs font-semibold text-slate-200">
      {children}
    </span>
  )
}

function WordsTab(props: {
  data: AppData
  words: WordItem[]
  levelMap: Map<number, LevelConfig>
  search: string
  setSearch: (v: string) => void
  editId: string | null
  draft: { word: string; hint: string; def: string }
  setDraft: { setWord: (v: string) => void; setHint: (v: string) => void; setDef: (v: string) => void }
  onBeginEdit: (w: WordItem) => void
  onCancelEdit: () => void
  onSave: () => void
  onDelete: (id: string) => void
  onSetLevel: (id: string, levelId: number) => void
}) {
  const {
    data,
    words,
    levelMap,
    search,
    setSearch,
    editId,
    draft,
    setDraft,
    onBeginEdit,
    onCancelEdit,
    onSave,
    onDelete,
    onSetLevel,
  } = props

  const levels = data.config.levels

  return (
    <div className="grid gap-4">
      <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-lg font-semibold">Words</div>
            <div className="mt-1 text-sm text-slate-300">
              Manage your vocabulary list, edit content, and manually promote/demote.
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search (word, hint, definition)"
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 outline-none focus:border-slate-400 sm:w-80"
            />
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-5">
            <div className="text-sm font-semibold">{editId ? 'Edit word' : 'Add word'}</div>
            <div className="mt-3 grid gap-3">
              <Field label="Word">
                <input
                  value={draft.word}
                  onChange={(e) => setDraft.setWord(e.target.value)}
                  placeholder="e.g., ephemeral"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 outline-none focus:border-slate-400"
                />
              </Field>
              <Field label="Hint">
                <input
                  value={draft.hint}
                  onChange={(e) => setDraft.setHint(e.target.value)}
                  placeholder="short clue"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 outline-none focus:border-slate-400"
                />
              </Field>
              <Field label="Definition">
                <textarea
                  value={draft.def}
                  onChange={(e) => setDraft.setDef(e.target.value)}
                  placeholder="meaning / translation / example"
                  rows={4}
                  className="w-full resize-none rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 outline-none focus:border-slate-400"
                />
              </Field>

              <div className="flex gap-2">
                <button
                  onClick={onSave}
                  className="w-full rounded-xl bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-300"
                >
                  {editId ? 'Save changes' : 'Add word'}
                </button>
                <button
                  onClick={onCancelEdit}
                  className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-900"
                >
                  Clear
                </button>
              </div>

              <div className="text-xs text-slate-400">
                New words start at the first level and are due immediately.
              </div>
            </div>
          </div>
        </div>

        <div className="lg:col-span-3">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-5">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">Your list ({words.length})</div>
              <div className="text-xs text-slate-400">Click a row to edit</div>
            </div>

            <div className="mt-4 overflow-hidden rounded-xl border border-slate-800">
              <div className="max-h-[560px] overflow-auto">
                <table className="min-w-full divide-y divide-slate-800 text-sm">
                  <thead className="sticky top-0 bg-slate-950">
                    <tr className="text-left text-xs text-slate-400">
                      <th className="px-3 py-2">Word</th>
                      <th className="px-3 py-2">Level</th>
                      <th className="px-3 py-2">Due</th>
                      <th className="px-3 py-2">Stats</th>
                      <th className="px-3 py-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800 bg-slate-950/30">
                    {words.map((w) => (
                      <tr
                        key={w.id}
                        className={
                          'cursor-pointer hover:bg-slate-900/40 ' +
                          (editId === w.id ? 'bg-slate-900/60' : '')
                        }
                        onClick={() => onBeginEdit(w)}
                      >
                        <td className="px-3 py-2">
                          <div className="font-semibold text-slate-100">{w.word}</div>
                          <div className="text-xs text-slate-400 line-clamp-1">{w.hint || '—'}</div>
                        </td>
                        <td className="px-3 py-2">
                          <select
                            value={w.levelId}
                            onChange={(e) => {
                              e.stopPropagation()
                              onSetLevel(w.id, Number(e.target.value))
                            }}
                            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 outline-none"
                          >
                            {levels.map((lvl) => (
                              <option key={lvl.id} value={lvl.id}>
                                {lvl.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-300">{formatShortDate(w.dueAt)}</td>
                        <td className="px-3 py-2 text-xs text-slate-300">
                          <div>
                            R:{' '}
                            <span className="font-semibold text-slate-100">{w.totalRight}</span> / W:{' '}
                            <span className="font-semibold text-slate-100">{w.totalWrong}</span>
                          </div>
                          <div className="text-slate-500">
                            Streak: {w.streakCorrect}/{levelMap.get(w.levelId)?.promoteAfterCorrect ?? '—'}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              if (confirm(`Delete “${w.word}”?`)) onDelete(w.id)
                            }}
                            className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-xs font-semibold text-slate-200 hover:bg-slate-900"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                    {words.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-3 py-10 text-center text-sm text-slate-400">
                          No words yet. Add some on the left.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="mt-4 grid gap-2 text-xs text-slate-400">
              <div>
                Manual level changes reset the streak and make the card due immediately.
              </div>
              <div>
                Editing a word does not change its scheduling.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1">
      <span className="text-xs font-semibold text-slate-300">{label}</span>
      {children}
    </label>
  )
}

function SettingsTab(props: {
  configDraft: AppConfig
  setConfigDraft: (c: AppConfig) => void
  onApply: () => void
  onResetDefaults: () => void
  exportJson: () => void
  importText: string
  setImportText: (v: string) => void
  importJsonFromText: () => Promise<void>
  importJsonFromFile: (file: File) => Promise<void>
  wipeAllData: () => Promise<void>
  fileInputRef: React.RefObject<HTMLInputElement | null>
  importing: boolean
}) {
  const {
    configDraft,
    setConfigDraft,
    onApply,
    onResetDefaults,
    exportJson,
    importText,
    setImportText,
    importJsonFromText,
    importJsonFromFile,
    wipeAllData,
    fileInputRef,
    importing,
  } = props

  const levels = configDraft.levels

  function updateLevel(idx: number, patch: Partial<LevelConfig>) {
    const next = levels.map((l, i) => (i === idx ? { ...l, ...patch } : l))
    // Ensure IDs stay unique and sorted
    const normalized = normalizeConfig({ ...configDraft, levels: next })
    setConfigDraft(normalized)
  }

  function addLevel() {
    const maxId = Math.max(...levels.map((l) => l.id), 0)
    const next: LevelConfig = {
      id: maxId + 1,
      name: `Level ${maxId + 1}`,
      promoteAfterCorrect: 1,
      intervalDays: 30,
    }
    const normalized = normalizeConfig({ ...configDraft, levels: [...levels, next] })
    setConfigDraft(normalized)
  }

  function removeLevel(id: number) {
    if (levels.length <= 1) return
    if (!confirm(`Remove level ${id}? Cards at this level will be normalized when you apply settings.`)) return
    const next = levels.filter((l) => l.id !== id)
    const normalized = normalizeConfig({ ...configDraft, levels: next })
    setConfigDraft(normalized)
  }

  return (
    <div className="grid gap-4">
      <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-lg font-semibold">Settings</div>
            <div className="mt-1 text-sm text-slate-300">
              Configure levels, promotion thresholds, and review intervals.
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={onApply}
              className="rounded-xl bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-white"
            >
              Apply
            </button>
            <button
              onClick={onResetDefaults}
              className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-900"
            >
              Reset draft
            </button>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-5">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">Levels</div>
          <button
            onClick={addLevel}
            className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-900"
          >
            Add level
          </button>
        </div>

        <div className="mt-4 grid gap-3">
          {levels
            .slice()
            .sort((a, b) => a.id - b.id)
            .map((lvl, idx) => (
              <div key={lvl.id} className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2">
                    <div className="text-sm font-semibold text-slate-100">ID {lvl.id}</div>
                    <span className="text-xs text-slate-400">(max level is the highest ID)</span>
                  </div>
                  <button
                    onClick={() => removeLevel(lvl.id)}
                    className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-xs font-semibold text-slate-200 hover:bg-slate-900 disabled:opacity-50"
                    disabled={levels.length <= 1}
                  >
                    Remove
                  </button>
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <Field label="Name">
                    <input
                      value={lvl.name}
                      onChange={(e) => updateLevel(idx, { name: e.target.value })}
                      className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-400"
                    />
                  </Field>

                  <Field label="Promote after correct (streak)">
                    <input
                      type="number"
                      value={lvl.promoteAfterCorrect}
                      min={1}
                      onChange={(e) => updateLevel(idx, { promoteAfterCorrect: clampInt(Number(e.target.value), 1, 99) })}
                      className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-400"
                    />
                  </Field>

                  <Field label="Interval days after correct">
                    <input
                      type="number"
                      value={lvl.intervalDays}
                      min={0}
                      onChange={(e) => updateLevel(idx, { intervalDays: clampInt(Number(e.target.value), 0, 3650) })}
                      className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-400"
                    />
                  </Field>
                </div>

                <div className="mt-2 text-xs text-slate-400">
                  When you answer right at this level, due date moves forward by interval days.
                </div>
              </div>
            ))}
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
            <div className="text-sm font-semibold">Wrong answer behavior</div>
            <div className="mt-3 grid gap-3">
              <label className="flex items-center gap-2 text-sm text-slate-200">
                <input
                  type="checkbox"
                  checked={configDraft.wrongMakesImmediatelyDue}
                  onChange={(e) => setConfigDraft({ ...configDraft, wrongMakesImmediatelyDue: e.target.checked })}
                  className="h-4 w-4"
                />
                Wrong makes the card due immediately
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-200">
                <input
                  type="checkbox"
                  checked={configDraft.wrongResetsStreak}
                  onChange={(e) => setConfigDraft({ ...configDraft, wrongResetsStreak: e.target.checked })}
                  className="h-4 w-4"
                />
                Wrong resets the streak for the current level
              </label>
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
            <div className="text-sm font-semibold">Storage and backups</div>
            <div className="mt-2 text-sm text-slate-300">
              This app uses <span className="font-semibold text-slate-100">Supabase</span> for cloud storage.
              Your data syncs automatically across devices. You can still export/import for backups.
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={exportJson}
                className="rounded-xl bg-emerald-400 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-emerald-300"
              >
                Export JSON
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-900"
              >
                Import file
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0]
                  if (f) await importJsonFromFile(f)
                }}
              />
            </div>

            <div className="mt-3 grid gap-2">
              <textarea
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder="Paste exported JSON here (optional)"
                rows={6}
                className="w-full resize-none rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 outline-none focus:border-slate-400"
              />
              <button
                onClick={importJsonFromText}
                className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-white disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={!importText.trim() || importing}
              >
                {importing ? 'Importing...' : 'Import from text'}
              </button>
            </div>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-rose-900/40 bg-rose-950/20 p-4">
          <div className="text-sm font-semibold text-rose-200">Danger zone</div>
          <div className="mt-2 text-sm text-rose-200/80">
            Wipe everything (words, progress, settings).
          </div>
          <button
            onClick={wipeAllData}
            className="mt-3 rounded-xl bg-rose-400 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-rose-300"
          >
            Wipe all data
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-5">
        <div className="text-sm font-semibold">About this multi-user system</div>
        <div className="mt-2 text-sm text-slate-300">
          This app uses Supabase (PostgreSQL) for cloud storage. Words are shared across all users,
          while progress is tracked individually per user. Configuration settings are global and affect all users.
          Your data syncs automatically and is accessible from any device.
        </div>
      </div>
    </div>
  )
}

// ---------------- Core Logic ----------------

function normalizeConfig(cfg: AppConfig): AppConfig {
  const levels = Array.isArray(cfg.levels) ? cfg.levels : defaultConfig.levels
  const normalizedLevels = levels
    .map((l, i) => ({
      id: Number.isFinite(l.id) ? Math.trunc(l.id) : i + 1,
      name: String(l.name ?? `Level ${i + 1}`),
      promoteAfterCorrect: clampInt(Number(l.promoteAfterCorrect ?? 1), 1, 99),
      intervalDays: clampInt(Number(l.intervalDays ?? 0), 0, 3650),
    }))
    .sort((a, b) => a.id - b.id)

  // Ensure unique IDs
  const unique: LevelConfig[] = []
  const seen = new Set<number>()
  for (const l of normalizedLevels) {
    if (seen.has(l.id)) continue
    seen.add(l.id)
    unique.push(l)
  }

  // Ensure at least 1 level
  const finalLevels = unique.length ? unique : defaultConfig.levels

  return {
    levels: finalLevels,
    wrongMakesImmediatelyDue: !!cfg.wrongMakesImmediatelyDue,
    wrongResetsStreak: !!cfg.wrongResetsStreak,
  }
}

function normalizeWord(w: WordItem, cfg: AppConfig): WordItem {
  const nowIso = toISO(new Date())
  const firstLevelId = prevSafeFirstLevelId(cfg)
  const maxLevelId = maxLevel(cfg)

  const levelId = clampToExistingLevel(w.levelId ?? firstLevelId, cfg)
  const dueAt = w.dueAt ? w.dueAt : nowIso

  return {
    id: String(w.id || uuid()),
    word: String(w.word || '').trim(),
    hint: String(w.hint || '').trim(),
    definition: String(w.definition || '').trim(),
    createdAt: w.createdAt || nowIso,
    updatedAt: w.updatedAt || nowIso,

    levelId,
    streakCorrect: clampInt(Number(w.streakCorrect ?? 0), 0, 9999),
    totalRight: clampInt(Number(w.totalRight ?? 0), 0, 999999),
    totalWrong: clampInt(Number(w.totalWrong ?? 0), 0, 999999),
    lastReviewedAt: w.lastReviewedAt,
    dueAt,
    lastResult: w.lastResult === 'right' || w.lastResult === 'wrong' ? w.lastResult : undefined,
  }
}

function prevSafeFirstLevelId(cfg: AppConfig): number {
  const ids = cfg.levels.map((l) => l.id).sort((a, b) => a - b)
  return ids[0] ?? 1
}

function maxLevel(cfg: AppConfig): number {
  const ids = cfg.levels.map((l) => l.id)
  return ids.length ? Math.max(...ids) : 1
}

function clampToExistingLevel(levelId: number, cfg: AppConfig): number {
  const ids = new Set(cfg.levels.map((l) => l.id))
  if (ids.has(levelId)) return levelId
  // If missing, clamp to nearest
  const sorted = cfg.levels.map((l) => l.id).sort((a, b) => a - b)
  if (!sorted.length) return 1
  const min = sorted[0]
  const max = sorted[sorted.length - 1]
  if (levelId < min) return min
  if (levelId > max) return max
  // Otherwise choose closest existing
  let best = sorted[0]
  let bestDist = Math.abs(sorted[0] - levelId)
  for (const id of sorted) {
    const d = Math.abs(id - levelId)
    if (d < bestDist) {
      bestDist = d
      best = id
    }
  }
  return best
}

function applyAnswer(args: { word: WordItem; right: boolean; config: AppConfig }): WordItem {
  const { word, right, config } = args
  const now = new Date()
  const nowIso = toISO(now)

  const level = config.levels.find((l) => l.id === word.levelId) ?? config.levels[0]
  const maxLevelId = maxLevel(config)

  const updated: WordItem = {
    ...word,
    updatedAt: nowIso,
    lastReviewedAt: nowIso,
    lastResult: right ? 'right' : 'wrong',
    totalRight: word.totalRight + (right ? 1 : 0),
    totalWrong: word.totalWrong + (!right ? 1 : 0),
  }

  if (!right) {
    if (config.wrongResetsStreak) updated.streakCorrect = 0
    if (config.wrongMakesImmediatelyDue) {
      updated.dueAt = nowIso
    } else {
      // If not immediate, keep dueAt as-is
      updated.dueAt = word.dueAt
    }
    return updated
  }

  // Right answer
  const nextStreak = word.streakCorrect + 1
  updated.streakCorrect = nextStreak

  // Schedule next due based on level interval days
  const base = todayStartLocal() // make due stable relative to local day
  const interval = clampInt(level?.intervalDays ?? 0, 0, 3650)
  updated.dueAt = toISO(addDays(base, interval))

  // Promote if threshold met and not at max
  const threshold = clampInt(level?.promoteAfterCorrect ?? 1, 1, 99)
  if (word.levelId < maxLevelId && nextStreak >= threshold) {
    const nextLevelId = nextHigherLevelId(word.levelId, config)
    updated.levelId = nextLevelId
    updated.streakCorrect = 0

    // After promotion, reschedule using the next level interval (due in that interval)
    const promotedLevel = config.levels.find((l) => l.id === nextLevelId)
    const promotedInterval = clampInt(promotedLevel?.intervalDays ?? interval, 0, 3650)
    updated.dueAt = toISO(addDays(base, promotedInterval))
  }

  // If already max, keep there forever (no further promotion). dueAt still advances.
  return updated
}

function nextHigherLevelId(current: number, cfg: AppConfig): number {
  const sorted = cfg.levels.map((l) => l.id).sort((a, b) => a - b)
  for (const id of sorted) {
    if (id > current) return id
  }
  return sorted[sorted.length - 1] ?? current
}

function pickNextCardId(args: {
  data: AppData
  dueWords: WordItem[]
  sessionWrongPool: string[]
  avoidId?: string
}): string | null {
  const { data, dueWords, sessionWrongPool, avoidId } = args

  // Strategy:
  // 1) If we have sessionWrongPool IDs, pick the earliest-due among them.
  // 2) Else pick the earliest-due among due words.
  // 3) If none, return null.

  const map = new Map<string, WordItem>()
  for (const w of data.words) map.set(w.id, w)

  const candidatesWrong = sessionWrongPool
    .map((id) => map.get(id))
    .filter(Boolean) as WordItem[]
  candidatesWrong.sort(sortByDueThenUpdated)

  const pickFrom = (list: WordItem[]) => {
    if (!list.length) return null
    if (avoidId && list.length > 1) {
      const first = list.find((w) => w.id !== avoidId)
      return first?.id ?? list[0].id
    }
    return list[0].id
  }

  const fromWrong = pickFrom(candidatesWrong)
  if (fromWrong) return fromWrong

  // Recompute due words from current data, not stale prop
  const now = new Date()
  const computedDue = data.words.filter((w) => isDue(w, now)).sort(sortByDueThenUpdated)

  const fromDue = pickFrom(computedDue.length ? computedDue : dueWords)
  return fromDue
}
