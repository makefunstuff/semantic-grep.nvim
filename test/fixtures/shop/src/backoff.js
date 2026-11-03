export function nextDelay(attempt, base = 250) {
  const jitter = Math.random() * base
  return Math.min(30_000, base * 2 ** attempt + jitter)
}
