'use client'

import { useState, useEffect, useRef } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import {
  createVersusRoom,
  joinVersusRoom,
  getVersusRoom,
  updateVersusRoom,
  startVersusGame,
  subscribeToVersusRoom,
  deleteVersusRoom,
  type VersusRoom,
  type VersusWord,
} from '../lib/versus-operations'
import { getAllWordsWithProgress } from '../lib/db-operations'
import { soundPlayer } from '../lib/sound-utils'

type VersusState = 'menu' | 'creating' | 'joining' | 'waiting' | 'playing' | 'finished'

const ROOM_STORAGE_KEY = 'vocab-kai-versus-room'

export default function VersusMode(props: {
  currentUserId: string
  currentUserName: string
  onExit: () => void
}) {
  const { currentUserId, currentUserName, onExit } = props

  const [state, setState] = useState<VersusState>('menu')
  const [room, setRoom] = useState<VersusRoom | null>(null)
  const [joinCode, setJoinCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isRejoining, setIsRejoining] = useState(false)

  const channelRef = useRef<RealtimeChannel | null>(null)
  const [displayTime, setDisplayTime] = useState(Date.now())

  // Update display time every second for live timer display
  useEffect(() => {
    const interval = setInterval(() => {
      setDisplayTime(Date.now())
    }, 1000)

    return () => clearInterval(interval)
  }, [])

  // Helper to calculate current time including elapsed time for active player
  const getCurrentTime = (playerTime: number, isCurrentTurn: boolean) => {
    if (!room || !isCurrentTurn || !room.turnStartTime) {
      return playerTime
    }
    const elapsed = displayTime - new Date(room.turnStartTime).getTime()
    return playerTime + Math.max(0, elapsed)
  }

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
        console.log('Attempting to rejoin room:', savedRoomId)
        const roomData = await getVersusRoom(savedRoomId)

        if (roomData && roomData.status !== 'finished') {
          // Verify user is part of this room
          if (roomData.playerAId === currentUserId || roomData.playerBId === currentUserId) {
            console.log('Rejoined room successfully:', {
              roomCode: roomData.roomCode,
              status: roomData.status,
              playerAName: roomData.playerAName,
              playerBName: roomData.playerBName,
            })
            setRoom(roomData)

            if (roomData.status === 'waiting') {
              setState('waiting')
            } else if (roomData.status === 'active') {
              setState('playing')
            }
          } else {
            // User not part of room, clear storage
            console.warn('User not part of saved room, clearing')
            localStorage.removeItem(ROOM_STORAGE_KEY)
          }
        } else {
          // Room finished or doesn't exist, clear storage
          console.log('Room finished or not found, clearing storage')
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
    }
  }, [])

  // Subscribe to room updates
  useEffect(() => {
    if (!room) return

    const channel = subscribeToVersusRoom(room.id, (updatedRoom) => {
      // Preserve word arrays if they're missing in the update (shouldn't happen, but defensive)
      if (updatedRoom.playerAWords.length === 0 && room.playerAWords.length > 0) {
        console.warn('Realtime update missing playerAWords, preserving existing')
        updatedRoom.playerAWords = room.playerAWords
      }
      if (updatedRoom.playerBWords.length === 0 && room.playerBWords.length > 0) {
        console.warn('Realtime update missing playerBWords, preserving existing')
        updatedRoom.playerBWords = room.playerBWords
      }

      // Preserve player names (realtime doesn't include JOIN data)
      if (!updatedRoom.playerAName && room.playerAName) {
        updatedRoom.playerAName = room.playerAName
      }
      if (!updatedRoom.playerBName && room.playerBName) {
        updatedRoom.playerBName = room.playerBName
      }

      console.log('Room updated via realtime:', {
        currentTurn: updatedRoom.currentTurn,
        playerAIndex: updatedRoom.playerAIndex,
        playerBIndex: updatedRoom.playerBIndex,
        hasPlayerAName: !!updatedRoom.playerAName,
        hasPlayerBName: !!updatedRoom.playerBName,
      })

      setRoom(updatedRoom)

      // If player B just joined and we don't have their name, fetch it
      if (updatedRoom.playerBId && !updatedRoom.playerBName && room.playerBId !== updatedRoom.playerBId) {
        console.log('Player B joined, fetching updated room data with names')
        getVersusRoom(updatedRoom.id).then((freshRoom) => {
          if (freshRoom) {
            // Merge fresh data (with names) into current room state
            setRoom((current) => ({
              ...current!,
              playerAName: freshRoom.playerAName,
              playerBName: freshRoom.playerBName,
            }))
          }
        }).catch(console.error)
      }

      // Update state based on room status
      if (updatedRoom.status === 'active' && (state === 'waiting' || state === 'finished')) {
        // Game starting or restarting
        setState('playing')
      } else if (updatedRoom.status === 'finished') {
        // Don't clear saved room - allow play again
        if (state === 'playing') {
          setState('finished')
        }
      }
    })

    channelRef.current = channel

    return () => {
      channel.unsubscribe()
      channelRef.current = null
    }
  }, [room?.id, state, room?.playerAWords, room?.playerBWords, room?.playerAName, room?.playerBName])

  async function handleCreateRoom() {
    try {
      setError(null)
      setState('creating')

      const { roomCode, roomId } = await createVersusRoom(currentUserId)
      const roomData = await getVersusRoom(roomId)

      if (roomData) {
        console.log('Room created with data:', {
          playerAName: roomData.playerAName,
          playerBName: roomData.playerBName,
          playerAId: roomData.playerAId,
          playerBId: roomData.playerBId,
        })
        setRoom(roomData)
        setState('waiting')
        // Save room ID to localStorage for rejoin capability
        localStorage.setItem(ROOM_STORAGE_KEY, roomId)
      }
    } catch (err: any) {
      console.error('Error creating room:', err)
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

      const roomId = await joinVersusRoom(joinCode.toUpperCase(), currentUserId)
      const roomData = await getVersusRoom(roomId)

      if (roomData) {
        console.log('Joined room with data:', {
          playerAName: roomData.playerAName,
          playerBName: roomData.playerBName,
          playerAId: roomData.playerAId,
          playerBId: roomData.playerBId,
        })
        setRoom(roomData)
        // Save room ID to localStorage for rejoin capability
        localStorage.setItem(ROOM_STORAGE_KEY, roomId)

        // If room is active, we're rejoining - just start playing
        if (roomData.status === 'active') {
          console.log('Rejoining active game')
          setState('playing')
        } else if (roomData.status === 'waiting') {
          // New join - initialize the game
          await initializeGame(roomData)
        } else {
          setError('Room is no longer available')
          setState('menu')
        }
      }
    } catch (err: any) {
      console.error('Error joining room:', err)
      setError(err.message || 'Failed to join room')
      setState('menu')
    }
  }

  async function initializeGame(roomData: VersusRoom) {
    try {
      // Get all words for each player
      const [playerAWords, playerBWords] = await Promise.all([
        getAllWordsWithProgress(roomData.playerAId),
        getAllWordsWithProgress(roomData.playerBId!),
      ])

      // Helper function to select words with priority for attempted words
      const selectWords = (allWords: typeof playerAWords, count: number) => {
        // Separate attempted words (those that have been reviewed) from unattempted
        const attempted = allWords.filter(
          (w) => w.lastReviewedAt || w.totalRight > 0 || w.totalWrong > 0
        )
        const unattempted = allWords.filter(
          (w) => !w.lastReviewedAt && w.totalRight === 0 && w.totalWrong === 0
        )

        // Shuffle both pools
        const shuffledAttempted = [...attempted].sort(() => Math.random() - 0.5)
        const shuffledUnattempted = [...unattempted].sort(() => Math.random() - 0.5)

        // Take from attempted first, then unattempted if needed
        const selected = [
          ...shuffledAttempted.slice(0, count),
          ...shuffledUnattempted.slice(0, Math.max(0, count - shuffledAttempted.length)),
        ]

        // Shuffle final selection to randomize order
        return selected.sort(() => Math.random() - 0.5).slice(0, count)
      }

      // Validate: both players must have at least 1 word
      if (playerAWords.length === 0) {
        setError('Player A has no words in their vocabulary. Add some words first!')
        setState('menu')
        return
      }
      if (playerBWords.length === 0) {
        setError('Player B has no words in their vocabulary. Add some words first!')
        setState('menu')
        return
      }

      // Select 10 words for each player, prioritizing attempted words
      const selectedA = selectWords(playerAWords, 10)
      const selectedB = selectWords(playerBWords, 10)

      // Player A gets Player B's words to read
      const wordsForA: VersusWord[] = selectedB.map((w) => ({
        id: w.id,
        word: w.word,
        hint: w.hint,
        definition: w.definition,
        imageUrl: w.imageUrl,
      }))

      // Player B gets Player A's words to read
      const wordsForB: VersusWord[] = selectedA.map((w) => ({
        id: w.id,
        word: w.word,
        hint: w.hint,
        definition: w.definition,
        imageUrl: w.imageUrl,
      }))

      await startVersusGame(roomData.id, wordsForA, wordsForB)

      setState('playing')
    } catch (err) {
      console.error('Error initializing game:', err)
      setError('Failed to start game')
      setState('menu')
    }
  }

  async function handleAnswer(correct: boolean) {
    if (!room || room.currentTurn !== currentUserId) return

    // Play right or wrong sound
    soundPlayer.play(correct ? 'rightAnswer' : 'wrongAnswer')

    const isPlayerA = currentUserId === room.playerAId
    const currentIndex = isPlayerA ? room.playerAIndex : room.playerBIndex
    const totalWords = isPlayerA ? room.playerAWords.length : room.playerBWords.length
    const newIndex = currentIndex + 1

    if (correct) {
      // Correct answer - OPPONENT gets the point (they answered correctly)
      // Player A reads to Player B, so if correct, Player B gets the point
      const newRightCount = isPlayerA ? room.playerBRightCount + 1 : room.playerARightCount + 1

      if (newIndex >= totalWords) {
        // Player finished all words! Calculate final time
        const turnElapsed = room.turnStartTime
          ? Date.now() - new Date(room.turnStartTime).getTime()
          : 0
        const newTime = isPlayerA ? room.playerATime + turnElapsed : room.playerBTime + turnElapsed

        await updateVersusRoom(room.id, {
          ...(isPlayerA
            ? { playerAIndex: newIndex, playerBRightCount: newRightCount, playerATime: newTime }
            : { playerBIndex: newIndex, playerARightCount: newRightCount, playerBTime: newTime }),
        })
        await finishGame(isPlayerA)
      } else {
        // Continue with next word
        await updateVersusRoom(room.id, {
          ...(isPlayerA
            ? { playerAIndex: newIndex, playerBRightCount: newRightCount }
            : { playerBIndex: newIndex, playerARightCount: newRightCount }),
        })
      }
    } else {
      // Wrong answer - OPPONENT gets wrong count (they answered wrong)
      const newWrongCount = isPlayerA ? room.playerBWrongCount + 1 : room.playerAWrongCount + 1
      const nextTurn = isPlayerA ? room.playerBId! : room.playerAId

      // Calculate elapsed time for current turn and add to total
      const turnElapsed = room.turnStartTime
        ? Date.now() - new Date(room.turnStartTime).getTime()
        : 0
      const newTime = isPlayerA ? room.playerATime + turnElapsed : room.playerBTime + turnElapsed

      if (newIndex >= totalWords) {
        // Player finished all words (but got last one wrong)
        await updateVersusRoom(room.id, {
          ...(isPlayerA
            ? { playerAIndex: newIndex, playerBWrongCount: newWrongCount, playerATime: newTime }
            : { playerBIndex: newIndex, playerAWrongCount: newWrongCount, playerBTime: newTime }),
        })
        await finishGame(isPlayerA)
      } else {
        // Move to next word and switch turns
        await updateVersusRoom(room.id, {
          currentTurn: nextTurn,
          turnStartTime: new Date().toISOString(),
          ...(isPlayerA
            ? { playerAIndex: newIndex, playerBWrongCount: newWrongCount, playerATime: newTime }
            : { playerBIndex: newIndex, playerAWrongCount: newWrongCount, playerBTime: newTime }),
        })
      }
    }
  }

  async function finishGame(playerAFinished: boolean) {
    if (!room) return

    const otherPlayerIndex = playerAFinished ? room.playerBIndex : room.playerAIndex
    const otherPlayerTotal = playerAFinished ? room.playerBWords.length : room.playerAWords.length

    if (otherPlayerIndex >= otherPlayerTotal) {
      // Both finished - compare RIGHT ANSWER COUNTS (not times!)
      // Player A reads to Player B, so Player B's right count is their score
      // Player B reads to Player A, so Player A's right count is their score
      const playerAScore = room.playerARightCount
      const playerBScore = room.playerBRightCount

      let winnerId: string
      if (playerAScore > playerBScore) {
        winnerId = room.playerAId
      } else if (playerBScore > playerAScore) {
        winnerId = room.playerBId!
      } else {
        // Tie - use time as tiebreaker
        winnerId = room.playerATime < room.playerBTime ? room.playerAId : room.playerBId!
      }

      // Play winner revealed sound
      soundPlayer.play('winnerRevealed')

      await updateVersusRoom(room.id, {
        status: 'finished',
        winnerId,
        currentTurn: null,
      })
    } else {
      // Give other player a chance if current player never gave up turn
      const currentWrongCount = playerAFinished ? room.playerAWrongCount : room.playerBWrongCount

      if (currentWrongCount === 0) {
        // Current player went flawless, give other player their turn
        const nextTurn = playerAFinished ? room.playerBId! : room.playerAId

        await updateVersusRoom(room.id, {
          currentTurn: nextTurn,
          turnStartTime: new Date().toISOString(),
        })
      } else {
        // Current player finished first, but other player still has a chance
        // Compare scores
        const playerAScore = room.playerARightCount
        const playerBScore = room.playerBRightCount

        let winnerId: string
        if (playerAScore > playerBScore) {
          winnerId = room.playerAId
        } else if (playerBScore > playerAScore) {
          winnerId = room.playerBId!
        } else {
          // Tie - player who finished wins
          winnerId = playerAFinished ? room.playerAId : room.playerBId!
        }

        // Play winner revealed sound
        soundPlayer.play('winnerRevealed')

        await updateVersusRoom(room.id, {
          status: 'finished',
          winnerId,
          currentTurn: null,
        })
      }
    }
  }

  async function handlePlayAgain() {
    if (!room) return

    try {
      setError(null)
      setState('joining') // Show loading state

      // Reinitialize game with new words
      await initializeGame(room)
    } catch (err: any) {
      console.error('Failed to restart game:', err)
      setError(err.message || 'Failed to restart game')
      setState('finished')
    }
  }

  async function handleLeaveGame() {
    if (!room) return

    try {
      // End the game for everyone
      await updateVersusRoom(room.id, {
        status: 'finished',
        winnerId: null, // No winner when someone leaves
      })

      handleExit()
    } catch (err) {
      console.error('Failed to leave game:', err)
      // Exit anyway
      handleExit()
    }
  }

  async function handleExitAndDeleteRoom() {
    if (!room) {
      onExit()
      return
    }

    try {
      // Delete the room from database
      await deleteVersusRoom(room.id)
    } catch (err) {
      console.error('Failed to delete room:', err)
      // Continue with exit even if deletion fails
    }

    handleExit()
  }

  function handleExit() {
    if (channelRef.current) {
      channelRef.current.unsubscribe()
    }
    // Clear saved room from localStorage
    localStorage.removeItem(ROOM_STORAGE_KEY)
    setRoom(null)
    setState('menu')
    onExit()
  }

  // Show loading state while rejoining
  if (isRejoining) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="text-lg text-slate-300">Reconnecting to room...</div>
      </div>
    )
  }

  // Render different screens based on state
  if (state === 'menu') {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="max-w-md w-full rounded-2xl border border-slate-800 bg-slate-900/30 p-8">
          <h2 className="text-2xl font-bold text-center mb-6">Versus Mode</h2>

          {error && (
            <div className="mb-4 rounded-xl bg-rose-950/20 border border-rose-900/40 p-3 text-sm text-rose-200">
              {error}
            </div>
          )}

          <div className="space-y-4">
            <button
              onClick={handleCreateRoom}
              className="w-full rounded-xl bg-emerald-400 px-6 py-4 text-lg font-semibold text-slate-950 hover:bg-emerald-300"
            >
              Create Room
            </button>

            <div className="text-center text-sm text-slate-400">or</div>

            <div className="space-y-2">
              <input
                type="text"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                placeholder="Enter Room Code"
                maxLength={4}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-center text-2xl font-mono text-slate-100 placeholder:text-slate-500 outline-none focus:border-slate-400"
              />
              <button
                onClick={handleJoinRoom}
                disabled={!joinCode.trim()}
                className="w-full rounded-xl bg-slate-100 px-6 py-4 text-lg font-semibold text-slate-950 hover:bg-white disabled:opacity-50"
              >
                Join Room
              </button>
            </div>
          </div>

          <button
            onClick={handleExitAndDeleteRoom}
            className="mt-6 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-900"
          >
            Back
          </button>
        </div>
      </div>
    )
  }

  if (state === 'waiting' && room) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="max-w-md w-full rounded-2xl border border-slate-800 bg-slate-900/30 p-8 text-center">
          <h2 className="text-2xl font-bold mb-4">Waiting for Opponent...</h2>

          <div className="my-8 rounded-2xl bg-slate-950 p-6">
            <div className="text-sm text-slate-400 mb-2">Room Code</div>
            <div className="text-5xl font-mono font-bold tracking-wider">{room.roomCode}</div>
          </div>

          <p className="text-slate-300 mb-4">Share this code with your opponent</p>

          <div className="space-y-2">
            <button
              onClick={handleLeaveGame}
              className="w-full rounded-xl border border-rose-700 bg-rose-950/20 px-4 py-2 text-sm font-semibold text-rose-200 hover:bg-rose-900/30"
            >
              Cancel & End Room
            </button>
            <button
              onClick={handleExit}
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-900"
            >
              Back (Keep Room Open)
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (state === 'playing' && room) {
    const isPlayerA = currentUserId === room.playerAId
    const isMyTurn = room.currentTurn === currentUserId
    const myWords = isPlayerA ? room.playerAWords : room.playerBWords
    const myIndex = isPlayerA ? room.playerAIndex : room.playerBIndex
    const currentWord = myWords[myIndex]

    // Debug logging for turn state
    console.log('Playing state:', {
      currentUserId,
      roomCurrentTurn: room.currentTurn,
      isMyTurn,
      isPlayerA,
      myIndex,
      myWordsLength: myWords.length,
      hasCurrentWord: !!currentWord,
    })

    // Debug logging
    if (!currentWord) {
      console.log('DEBUG: No current word!', {
        isPlayerA,
        isMyTurn,
        myWordsLength: myWords.length,
        myIndex,
        roomPlayerAWords: room.playerAWords.length,
        roomPlayerBWords: room.playerBWords.length,
        roomPlayerAIndex: room.playerAIndex,
        roomPlayerBIndex: room.playerBIndex,
      })
    }

    return (
      <div className="max-w-4xl mx-auto">
        <div className="grid gap-4">
          {/* Room Code Header */}
          <div className="flex items-center justify-between">
            <div className="flex-1"></div>
            <div className="inline-block rounded-xl bg-slate-950/40 border border-slate-700 px-4 py-2">
              <span className="text-xs text-slate-400 mr-2">Room Code:</span>
              <span className="text-lg font-mono font-bold tracking-wider">{room.roomCode}</span>
            </div>
            <div className="flex-1 flex justify-end">
              <button
                onClick={handleLeaveGame}
                className="rounded-xl border border-rose-700 bg-rose-950/20 px-4 py-2 text-sm font-semibold text-rose-200 hover:bg-rose-900/30"
              >
                Leave Game
              </button>
            </div>
          </div>

          {/* Game Header */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-5">
            <div className="grid grid-cols-2 gap-4">
              <div className={`rounded-xl p-4 ${isMyTurn ? 'bg-emerald-950/20 border-2 border-emerald-400' : 'bg-slate-950/40 border border-slate-800'}`}>
                <div className="text-sm text-slate-400">You</div>
                <div className="text-xl font-bold">{currentUserName}</div>
                <div className="mt-2 text-sm">
                  Progress: {myIndex} / {myWords.length}
                </div>
                <div className="text-sm text-slate-300">
                  Time: {formatTime(getCurrentTime(isPlayerA ? room.playerATime : room.playerBTime, isMyTurn))}
                </div>
              </div>

              <div className={`rounded-xl p-4 ${!isMyTurn ? 'bg-emerald-950/20 border-2 border-emerald-400' : 'bg-slate-950/40 border border-slate-800'}`}>
                <div className="text-sm text-slate-400">Opponent</div>
                <div className="text-xl font-bold">{isPlayerA ? room.playerBName || 'Player B' : room.playerAName || 'Player A'}</div>
                <div className="mt-2 text-sm">
                  Progress: {isPlayerA ? room.playerBIndex : room.playerAIndex} /{' '}
                  {isPlayerA ? room.playerBWords.length : room.playerAWords.length}
                </div>
                <div className="text-sm text-slate-300">
                  Time: {formatTime(getCurrentTime(isPlayerA ? room.playerBTime : room.playerATime, !isMyTurn))}
                </div>
              </div>
            </div>
          </div>

          {/* Current Word */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-6">
            {isMyTurn ? (
              <div>
                <div className="text-center mb-6">
                  <div className="text-sm text-emerald-400 mb-2">YOUR TURN - Read this word:</div>
                  <div className="flex items-center justify-center gap-3">
                    <div className="text-5xl font-bold">{currentWord?.word || 'Loading...'}</div>
                    {currentWord && (
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
                    )}
                  </div>
                </div>

                <div className="space-y-4 mb-6">
                  <div className="rounded-xl bg-slate-950/40 p-4">
                    <div className="text-sm text-slate-400 mb-2">Hint</div>
                    <div className="text-slate-200">{currentWord?.hint || '—'}</div>
                  </div>

                  {currentWord?.imageUrl && (
                    <div className="rounded-xl bg-slate-950/40 p-4">
                      <div className="text-sm text-slate-400 mb-2">Image Hint</div>
                      <div>
                        <img
                          src={currentWord.imageUrl}
                          alt="Word hint"
                          className="w-full max-w-md rounded-lg"
                        />
                      </div>
                    </div>
                  )}

                  <div className="rounded-xl bg-slate-950/40 p-4">
                    <div className="text-sm text-slate-400 mb-2">Definition</div>
                    <div className="text-slate-200">{currentWord?.definition || '—'}</div>
                  </div>
                </div>

                <div className="text-center text-sm text-slate-400 mb-6">
                  Opponent must define this word. Did they get it right?
                </div>

                <div className="flex gap-4">
                  <button
                    onClick={() => handleAnswer(false)}
                    className="flex-1 rounded-xl bg-rose-400 px-6 py-4 text-lg font-semibold text-slate-950 hover:bg-rose-300"
                  >
                    Wrong
                  </button>
                  <button
                    onClick={() => handleAnswer(true)}
                    className="flex-1 rounded-xl bg-emerald-400 px-6 py-4 text-lg font-semibold text-slate-950 hover:bg-emerald-300"
                  >
                    Right
                  </button>
                </div>
              </div>
            ) : (
              <div className="text-center py-12">
                <div className="text-lg text-slate-400 mb-4">{isPlayerA ? room.playerBName || "Opponent" : room.playerAName || "Opponent"}'s Turn</div>
                <div className="text-3xl font-bold mb-2">Listen and Answer!</div>
                <div className="text-slate-300">
                  {isPlayerA ? room.playerBName || 'Your opponent' : room.playerAName || 'Your opponent'} will read you a word. Define it to keep your turn.
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (state === 'joining') {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="text-lg text-slate-300">Starting new game...</div>
      </div>
    )
  }

  if (state === 'finished' && room) {
    const isPlayerA = currentUserId === room.playerAId
    const isWinner = room.winnerId === currentUserId
    const gameAbandoned = room.winnerId === null

    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="max-w-2xl w-full rounded-2xl border border-slate-800 bg-slate-900/30 p-8">
          <h2 className={`text-3xl font-bold text-center mb-8 ${gameAbandoned ? 'text-slate-400' : isWinner ? 'text-emerald-400' : 'text-rose-400'}`}>
            {gameAbandoned ? 'Game Ended' : isWinner ? '🏆 You Win!' : 'You Lost'}
          </h2>

          {gameAbandoned && (
            <p className="text-center text-slate-300 mb-6">A player left the game</p>
          )}

          <div className="grid grid-cols-2 gap-6 mb-8">
            <div className="rounded-xl bg-slate-950/40 p-6">
              <div className="text-sm text-slate-400 mb-2">{currentUserName}</div>
              <div className="space-y-2 text-sm">
                <div>
                  Completed: {isPlayerA ? room.playerAIndex : room.playerBIndex} /{' '}
                  {isPlayerA ? room.playerAWords.length : room.playerBWords.length}
                </div>
                <div>
                  Right: {isPlayerA ? room.playerARightCount : room.playerBRightCount}
                </div>
                <div>
                  Wrong: {isPlayerA ? room.playerAWrongCount : room.playerBWrongCount}
                </div>
                <div className="text-lg font-bold">
                  Time: {formatTime(isPlayerA ? room.playerATime : room.playerBTime)}
                </div>
              </div>
            </div>

            <div className="rounded-xl bg-slate-950/40 p-6">
              <div className="text-sm text-slate-400 mb-2">{isPlayerA ? room.playerBName || 'Opponent' : room.playerAName || 'Opponent'}</div>
              <div className="space-y-2 text-sm">
                <div>
                  Completed: {isPlayerA ? room.playerBIndex : room.playerAIndex} /{' '}
                  {isPlayerA ? room.playerBWords.length : room.playerAWords.length}
                </div>
                <div>
                  Right: {isPlayerA ? room.playerBRightCount : room.playerARightCount}
                </div>
                <div>
                  Wrong: {isPlayerA ? room.playerBWrongCount : room.playerAWrongCount}
                </div>
                <div className="text-lg font-bold">
                  Time: {formatTime(isPlayerA ? room.playerBTime : room.playerATime)}
                </div>
              </div>
            </div>
          </div>

          <div className="flex gap-4">
            <button
              onClick={handlePlayAgain}
              className="flex-1 rounded-xl bg-emerald-400 px-6 py-4 text-lg font-semibold text-slate-950 hover:bg-emerald-300"
            >
              Play Again
            </button>
            <button
              onClick={handleLeaveGame}
              className="flex-1 rounded-xl border border-slate-700 bg-slate-950 px-6 py-4 text-lg font-semibold text-slate-200 hover:bg-slate-900"
            >
              Leave Game
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="text-lg text-slate-300">Loading...</div>
    </div>
  )
}

function formatTime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}
