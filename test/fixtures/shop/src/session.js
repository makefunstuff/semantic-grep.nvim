export function expired(session, now = Date.now()) {
  return now - session.lastSeenAt > 30 * 60_000
}
