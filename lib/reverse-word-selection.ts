/**
 * Word selection and question generation logic for Reverse Mode
 * Generates multiple-choice questions with 1 correct and 2 wrong answers
 */

export type WordOption = {
  id: string
  word: string
}

export type Question = {
  wordId: string
  word: string
  definition: string
  options: WordOption[] // 3 options total (1 correct + 2 wrong), shuffled
}

/**
 * Generates wrong answer options using similarity heuristics
 * Selects words that are similar to the correct word to make the game more challenging
 */
export function generateWrongAnswers(
  correctWord: { id: string; word: string },
  allWords: { id: string; word: string }[],
  count: number = 2
): WordOption[] {
  // Filter out the correct word
  const candidateWords = allWords.filter((w) => w.id !== correctWord.id)

  if (candidateWords.length < count) {
    throw new Error(`Not enough words to generate ${count} wrong answers`)
  }

  // Scoring function: prefer words with similar characteristics
  const scoreWord = (candidate: string, correct: string): number => {
    let score = 0

    // Similar length (within 2 characters)
    const lengthDiff = Math.abs(candidate.length - correct.length)
    if (lengthDiff <= 2) score += 3

    // Same starting letter
    if (candidate[0].toLowerCase() === correct[0].toLowerCase()) score += 2

    // Contains similar substrings (3+ chars)
    for (let i = 0; i < correct.length - 2; i++) {
      const substr = correct.substring(i, i + 3).toLowerCase()
      if (candidate.toLowerCase().includes(substr)) {
        score += 1
      }
    }

    // Penalize very common/short words to avoid too-easy answers
    if (candidate.length <= 3) score -= 1

    // Add randomness to prevent predictable patterns (0-2 points)
    score += Math.random() * 2

    return score
  }

  // Score all candidates
  const scoredCandidates = candidateWords.map((w) => ({
    word: w,
    score: scoreWord(w.word, correctWord.word),
  }))

  // Sort by score (descending) and take top N
  scoredCandidates.sort((a, b) => b.score - a.score)

  const selected = scoredCandidates.slice(0, count).map((sc) => ({
    id: sc.word.id,
    word: sc.word.word,
  }))

  return selected
}

/**
 * Generates a complete question with shuffled options
 */
export function generateQuestion(
  correctWord: { id: string; word: string; definition: string },
  allWords: { id: string; word: string }[]
): Question {
  const wrongAnswers = generateWrongAnswers(correctWord, allWords, 2)

  // Shuffle options (1 correct + 2 wrong)
  const options = [{ id: correctWord.id, word: correctWord.word }, ...wrongAnswers].sort(
    () => Math.random() - 0.5
  )

  return {
    wordId: correctWord.id,
    word: correctWord.word,
    definition: correctWord.definition,
    options,
  }
}

/**
 * Selects N random words from a pool
 * Useful for both multiplayer and single-player modes
 */
export function selectRandomWords<T>(words: T[], count: number): T[] {
  if (words.length < count) {
    throw new Error(`Not enough words: need ${count}, have ${words.length}`)
  }

  const shuffled = [...words].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, count)
}
