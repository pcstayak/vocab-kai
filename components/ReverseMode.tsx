'use client'

import { useState, useEffect, useRef } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import {
  createReverseRoom,
  joinReverseRoom,
  getReverseRoom,
  updateReverseRoom,
  startReverseGame,
  advanceToNextQuestion,
  submitAnswer,
  checkAllAnswersAndCalculateBonus,
  getPlayerStats,
  getQuestionAnswers,
  subscribeToReverseRoom,
  deleteReverseRoom,
  type ReverseRoom,
  type ReverseWord,
  type PlayerStats,
  type ReverseAnswer,
} from '../lib/reverse-operations'
import { getAllWordsWithProgress } from '../lib/db-operations'
import { selectRandomWords } from '../lib/reverse-word-selection'
import { soundPlayer } from '../lib/sound-utils'

type ReverseState = 'menu' | 'creating' | 'joining' | 'lobby' | 'question' | 'results' | 'finished'

const ROOM_STORAGE_KEY = 'vocab-kai-reverse-room'

export default function ReverseMode(props: {
  currentUserId: string
  currentUserName: string
  onExit: () => void
}) {
  const { currentUserId, currentUserName, onExit } = props

  const [state, setState] = useState<ReverseState>('menu')
  const [room, setRoom] = useState<ReverseRoom | null>(null)
  const [joinCode, setJoinCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isRejoining, setIsRejoining] = useState(false)

  // Question state
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null)
  const [hasAnswered, setHasAnswered] = useState(false)
  const [questionTimer, setQuestionTimer] = useState(15)
  const [questionAnswers, setQuestionAnswers] = useState<ReverseAnswer[]>([])

  // Finished state
  const [finalStats, setFinalStats] = useState<PlayerStats[]>([])

  const channelRef = useRef<RealtimeChannel | null>(null)
  const answerCheckIntervalRef = useRef<NodeJS.Timeout | null>(null)

  // Attempt to rejoin room on mount
  useEffect(() => {
    async function attemptRejoin() {
      const savedRoomId = localStorage.getItem(ROOM_STORAGE_KEY)
      if (!savedRoomId) {
        setIsRejoining(false)
        return
      }

      try {
        setIsRejoining(true)
        const roomData = await getReverseRoom(savedRoomId)

        if (roomData && roomData.status !== 'finished') {
          // Verify user is part of this room
          const isPlayer = roomData.players.some((p) => p.userId === currentUserId)
          if (isPlayer) {
            setRoom(roomData)

            if (roomData.status === 'waiting') {
              setState('lobby')
            } else if (roomData.status === 'question') {
              setState('question')
            } else if (roomData.status === 'results') {
              setState('results')
            }
          } else {
            localStorage.removeItem(ROOM_STORAGE_KEY)
          }
        } else {
          localStorage.removeItem(ROOM_STORAGE_KEY)
        }
      } catch (err) {
        console.error('Failed to rejoin room:', err)
        setError('Failed to reconnect to previous room')
        localStorage.removeItem(ROOM_STORAGE_KEY)
      } finally {
        setIsRejoining(false)
      }
    }

    attemptRejoin()
  }, [currentUserId])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (channelRef.current) {
        channelRef.current.unsubscribe()
      }
      if (answerCheckIntervalRef.current) {
        clearInterval(answerCheckIntervalRef.current)
      }
    }
  }, [])

  // Subscribe to room updates
  useEffect(() => {
    if (!room) return

    const channel = subscribeToReverseRoom(room.id, (updatedRoom) => {
      setRoom(updatedRoom)

      // State transitions based on room status
      if (updatedRoom.status === 'question' && state !== 'question') {
        setState('question')
        setHasAnswered(false)
        setSelectedAnswer(null)
        setQuestionTimer(15)
      }

      if (updatedRoom.status === 'results' && state !== 'results') {
        setState('results')
      }

      if (updatedRoom.status === 'finished') {
        setState('finished')
        loadFinalStats(updatedRoom.id)
      }
    })

    channelRef.current = channel

    return () => {
      channel.unsubscribe()
    }
  }, [room?.id, state])

  // Question timer countdown
  useEffect(() => {
    if (state !== 'question' || !room?.questionStartTime || hasAnswered) return

    const interval = setInterval(() => {
      const elapsed = Date.now() - new Date(room.questionStartTime!).getTime()
      const remaining = Math.max(0, Math.ceil((room.questionDurationMs - elapsed) / 1000))

      setQuestionTimer(remaining)

      // Auto-submit when time's up
      if (remaining === 0 && !hasAnswered) {
        handleSelectAnswer('') // Empty string = wrong answer
      }
    }, 100)

    return () => clearInterval(interval)
  }, [state, room?.questionStartTime, hasAnswered])

  // Auto-advance from results to next question (host only)
  useEffect(() => {
    if (state !== 'results' || !room || room.hostId !== currentUserId) return

    const timeout = setTimeout(async () => {
      try {
        const allWords = await getAllWordsWithProgress(currentUserId)
        await advanceToNextQuestion(room.id, allWords)
      } catch (err: any) {
        console.error('Failed to advance question:', err)
      }
    }, 5000) // 5 second delay

    return () => clearTimeout(timeout)
  }, [state, room, currentUserId])

  // Periodically check if all players answered (for non-host)
  useEffect(() => {
    if (state !== 'question' || !room || !hasAnswered) return

    const interval = setInterval(async () => {
      try {
        await checkAllAnswersAndCalculateBonus(room.id, room.currentQuestionIndex)
      } catch (err) {
        // Ignore errors (host will handle this)
      }
    }, 1000)

    answerCheckIntervalRef.current = interval

    return () => {
      clearInterval(interval)
      answerCheckIntervalRef.current = null
    }
  }, [state, room, hasAnswered])

  // Load results answers when entering results state
  useEffect(() => {
    if (state === 'results' && room) {
      loadQuestionAnswers(room.id, room.currentQuestionIndex)
    }
  }, [state, room?.id, room?.currentQuestionIndex])

  async function loadQuestionAnswers(roomId: string, questionIndex: number) {
    try {
      const answers = await getQuestionAnswers(roomId, questionIndex)
      setQuestionAnswers(answers)
    } catch (err) {
      console.error('Failed to load question answers:', err)
    }
  }

  async function loadFinalStats(roomId: string) {
    try {
      const stats = await getPlayerStats(roomId)
      setFinalStats(stats)
    } catch (err) {
      console.error('Failed to load final stats:', err)
    }
  }

  async function handleCreateRoom() {
    try {
      setError(null)
      setState('creating')

      const { roomCode, roomId } = await createReverseRoom(currentUserId)

      // Save to localStorage for reconnection
      localStorage.setItem(ROOM_STORAGE_KEY, roomId)

      // Fetch full room data
      const roomData = await getReverseRoom(roomId)
      if (roomData) {
        setRoom(roomData)
        setState('lobby')
      }
    } catch (err: any) {
      setError(err.message || 'Failed to create room')
      setState('menu')
    }
  }

  async function handleJoinRoom() {
    if (!joinCode.trim()) {
      setError('Please enter a room code')
      return
    }

    try {
      setError(null)
      setState('joining')

      const roomId = await joinReverseRoom(joinCode.toUpperCase(), currentUserId)

      // Save to localStorage for reconnection
      localStorage.setItem(ROOM_STORAGE_KEY, roomId)

      // Fetch full room data
      const roomData = await getReverseRoom(roomId)
      if (roomData) {
        setRoom(roomData)
        setState('lobby')
      }
    } catch (err: any) {
      setError(err.message || 'Failed to join room')
      setState('menu')
    }
  }

  async function handleStartGame() {
    if (!room || room.hostId !== currentUserId) return

    try {
      setError(null)

      // Fetch all words from system
      const allWords = await getAllWordsWithProgress(currentUserId)

      if (allWords.length < 13) {
        setError('Need at least 13 words to play (10 questions + 3 for options)')
        return
      }

      // Select 10 random words
      const selectedWords = selectRandomWords(allWords, 10)
      const gameWords: ReverseWord[] = selectedWords.map((w) => ({
        id: w.id,
        word: w.word,
        hint: w.hint,
        definition: w.definition,
        imageUrl: w.imageUrl,
      }))

      // Start game
      await startReverseGame(room.id, gameWords)

      // Generate first question
      await advanceToNextQuestion(room.id, allWords)
    } catch (err: any) {
      setError(err.message || 'Failed to start game')
    }
  }

  async function handleSelectAnswer(wordId: string) {
    if (!room || hasAnswered) return

    const answerTime = Date.now() - new Date(room.questionStartTime!).getTime()

    setSelectedAnswer(wordId)
    setHasAnswered(true)

    try {
      await submitAnswer(room.id, room.currentQuestionIndex, currentUserId, wordId, answerTime)

      // If host, check if all answered
      if (room.hostId === currentUserId) {
        await checkAllAnswersAndCalculateBonus(room.id, room.currentQuestionIndex)
      }

      // Play sound
      const isCorrect = wordId === room.currentQuestion?.wordId
      soundPlayer.play(isCorrect ? 'rightAnswer' : 'wrongAnswer')
    } catch (err) {
      console.error('Failed to submit answer:', err)
    }
  }

  async function handleLeaveGame() {
    if (room) {
      // Don't delete room, just leave
      localStorage.removeItem(ROOM_STORAGE_KEY)
    }
    setRoom(null)
    setState('menu')
    onExit()
  }

  async function handleEndRoom() {
    if (room) {
      try {
        await deleteReverseRoom(room.id)
        localStorage.removeItem(ROOM_STORAGE_KEY)
      } catch (err) {
        console.error('Failed to delete room:', err)
      }
    }
    setRoom(null)
    setState('menu')
  }

  async function handlePlayAgain() {
    if (!room || room.hostId !== currentUserId) return

    try {
      // Reset room state
      await updateReverseRoom(room.id, {
        status: 'waiting',
        currentQuestionIndex: 0,
        currentQuestion: null,
        questionStartTime: null,
      })

      // Delete old answers
      // Note: This would require a new operation, for now just restart
      setState('lobby')
    } catch (err: any) {
      setError(err.message || 'Failed to restart game')
    }
  }

  // --- Render Screens ---

  if (isRejoining) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-slate-400">Reconnecting...</div>
      </div>
    )
  }

  // Menu Screen
  if (state === 'menu' || state === 'creating' || state === 'joining') {
    return (
      <div className="max-w-md mx-auto p-6 space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold text-emerald-400">Reverse Mode</h1>
          <p className="text-slate-400">Guess words from their definitions</p>
        </div>

        <div className="space-y-4">
          <button
            onClick={handleCreateRoom}
            disabled={state === 'creating'}
            className="w-full py-4 px-6 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-700 disabled:text-slate-500 text-white font-semibold rounded-lg transition"
          >
            {state === 'creating' ? 'Creating Room...' : 'Create Room'}
          </button>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-slate-700"></div>
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-2 bg-slate-900 text-slate-500">or</span>
            </div>
          </div>

          <div className="space-y-2">
            <input
              type="text"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              placeholder="Enter room code"
              maxLength={4}
              className="w-full py-3 px-4 bg-slate-800 border border-slate-700 rounded-lg text-white text-center text-xl tracking-widest uppercase placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
            <button
              onClick={handleJoinRoom}
              disabled={state === 'joining' || !joinCode.trim()}
              className="w-full py-3 px-6 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-600 text-white font-semibold rounded-lg transition"
            >
              {state === 'joining' ? 'Joining...' : 'Join Room'}
            </button>
          </div>
        </div>

        {error && (
          <div className="p-4 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm">
            {error}
          </div>
        )}

        <button
          onClick={onExit}
          className="w-full py-2 px-4 text-slate-400 hover:text-white transition"
        >
          Back
        </button>
      </div>
    )
  }

  // Lobby Screen
  if (state === 'lobby' && room) {
    const isHost = room.hostId === currentUserId
    const playerCount = room.players.length

    return (
      <div className="max-w-2xl mx-auto p-6 space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-bold text-emerald-400 tracking-wider">
            {room.roomCode}
          </h1>
          <p className="text-slate-400">Share this code with your friends</p>
        </div>

        <div className="bg-slate-800 border border-slate-700 rounded-lg p-6 space-y-4">
          <h2 className="text-xl font-semibold text-white">
            Players ({playerCount}/5)
          </h2>
          <div className="space-y-2">
            {room.players.map((player, index) => (
              <div
                key={player.id}
                className="flex items-center justify-between py-3 px-4 bg-slate-900 rounded-lg"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-emerald-600 rounded-full flex items-center justify-center text-white font-semibold">
                    {index + 1}
                  </div>
                  <span className="text-white">
                    {player.playerName}
                    {player.userId === currentUserId && ' (You)'}
                    {player.userId === room.hostId && ' 👑'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {error && (
          <div className="p-4 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm">
            {error}
          </div>
        )}

        <div className="space-y-2">
          {isHost && (
            <button
              onClick={handleStartGame}
              disabled={playerCount < 1}
              className="w-full py-4 px-6 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-700 disabled:text-slate-500 text-white font-bold text-lg rounded-lg transition"
            >
              Start Game
            </button>
          )}

          {!isHost && (
            <div className="text-center text-slate-400 py-4">
              Waiting for host to start the game...
            </div>
          )}

          <button
            onClick={isHost ? handleEndRoom : handleLeaveGame}
            className="w-full py-2 px-4 text-slate-400 hover:text-white transition"
          >
            {isHost ? 'Cancel & End Room' : 'Leave Room'}
          </button>
        </div>
      </div>
    )
  }

  // Question Screen
  if (state === 'question' && room && room.currentQuestion) {
    const question = room.currentQuestion

    return (
      <div className="max-w-3xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="text-slate-400">
            Question {room.currentQuestionIndex + 1} / {room.totalQuestions}
          </div>
          <div
            className={`text-2xl font-bold ${
              questionTimer <= 5 ? 'text-red-400' : 'text-emerald-400'
            }`}
          >
            {questionTimer}s
          </div>
        </div>

        {/* Definition */}
        <div className="bg-slate-800 border border-slate-700 rounded-lg p-8">
          <div className="text-center space-y-2">
            <div className="text-sm text-slate-500 uppercase tracking-wide">Definition</div>
            <div className="text-2xl text-white leading-relaxed">{question.definition}</div>
          </div>
        </div>

        {/* Options */}
        <div className="space-y-3">
          <div className="text-center text-slate-400 text-sm">Choose the correct word:</div>
          {question.options.map((option) => {
            const isSelected = selectedAnswer === option.id
            const isDisabled = hasAnswered

            return (
              <button
                key={option.id}
                onClick={() => !isDisabled && handleSelectAnswer(option.id)}
                disabled={isDisabled}
                className={`w-full py-6 px-8 rounded-lg font-semibold text-xl transition
                  ${
                    isSelected
                      ? 'bg-emerald-600 text-white ring-4 ring-emerald-400'
                      : 'bg-slate-700 hover:bg-slate-600 text-white'
                  }
                  ${isDisabled && !isSelected ? 'opacity-50 cursor-not-allowed' : ''}
                `}
              >
                {option.word}
              </button>
            )
          })}
        </div>

        {hasAnswered && (
          <div className="text-center text-slate-400 py-4">
            Waiting for other players...
          </div>
        )}

        <button
          onClick={handleLeaveGame}
          className="w-full py-2 px-4 text-slate-400 hover:text-white transition text-sm"
        >
          Leave Game
        </button>
      </div>
    )
  }

  // Results Screen
  if (state === 'results' && room && room.currentQuestion) {
    const correctWord = room.currentQuestion.word

    return (
      <div className="max-w-2xl mx-auto p-6 space-y-6">
        <div className="text-center space-y-4">
          <h2 className="text-2xl font-bold text-white">Question Results</h2>
          <div className="bg-emerald-900/30 border border-emerald-700 rounded-lg p-6">
            <div className="text-sm text-emerald-400 mb-2">Correct Answer</div>
            <div className="text-3xl font-bold text-white">{correctWord}</div>
          </div>
        </div>

        <div className="bg-slate-800 border border-slate-700 rounded-lg p-6 space-y-3">
          {room.players.map((player) => {
            const answer = questionAnswers.find((a) => a.userId === player.userId)
            const isCorrect = answer?.isCorrect || false
            const wasOnlyCorrect = answer?.wasOnlyCorrect || false

            return (
              <div
                key={player.id}
                className={`flex items-center justify-between py-3 px-4 rounded-lg ${
                  isCorrect ? 'bg-emerald-900/30' : 'bg-slate-900'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`text-2xl ${isCorrect ? 'text-emerald-400' : 'text-red-400'}`}
                  >
                    {isCorrect ? '✓' : '✗'}
                  </div>
                  <span className="text-white">{player.playerName}</span>
                </div>
                <div className="text-right">
                  <div className="text-white font-semibold">
                    {isCorrect && '+'}
                    {answer?.pointsEarned || 0} pts
                  </div>
                  {wasOnlyCorrect && (
                    <div className="text-xs text-emerald-400">Bonus! 🌟</div>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        <div className="text-center text-slate-400">Next question in a few seconds...</div>
      </div>
    )
  }

  // Finished Screen
  if (state === 'finished' && room) {
    return (
      <div className="max-w-2xl mx-auto p-6 space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-bold text-emerald-400">Game Complete!</h1>
          <p className="text-slate-400">Final Standings</p>
        </div>

        <div className="bg-slate-800 border border-slate-700 rounded-lg p-6 space-y-4">
          {finalStats.map((stat, index) => (
            <div
              key={stat.userId}
              className={`p-4 rounded-lg ${
                index === 0
                  ? 'bg-gradient-to-r from-yellow-900/30 to-yellow-800/20 border border-yellow-700'
                  : 'bg-slate-900'
              }`}
            >
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div
                    className={`text-2xl font-bold ${
                      index === 0
                        ? 'text-yellow-400'
                        : index === 1
                        ? 'text-slate-300'
                        : 'text-slate-500'
                    }`}
                  >
                    #{index + 1}
                  </div>
                  <div>
                    <div className="text-white font-semibold">{stat.playerName}</div>
                  </div>
                </div>
                <div className="text-3xl font-bold text-emerald-400">{stat.totalScore}</div>
              </div>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div className="text-center">
                  <div className="text-slate-500">Correct</div>
                  <div className="text-white font-semibold">{stat.correctAnswers}</div>
                </div>
                <div className="text-center">
                  <div className="text-slate-500">Bonus</div>
                  <div className="text-white font-semibold">{stat.bonusPoints}</div>
                </div>
                <div className="text-center">
                  <div className="text-slate-500">Avg Time</div>
                  <div className="text-white font-semibold">
                    {(stat.averageAnswerTimeMs / 1000).toFixed(1)}s
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-2">
          {room.hostId === currentUserId && (
            <button
              onClick={handlePlayAgain}
              className="w-full py-4 px-6 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg transition"
            >
              Play Again
            </button>
          )}
          <button
            onClick={handleLeaveGame}
            className="w-full py-2 px-4 text-slate-400 hover:text-white transition"
          >
            Leave Game
          </button>
        </div>
      </div>
    )
  }

  return null
}
