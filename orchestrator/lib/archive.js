// Archive eligibility shared by the CLI's preview and execution paths.

export const DEFAULT_ARCHIVE_AGE_MS = 24 * 60 * 60 * 1000;

export const ARCHIVEABLE_STATUSES = new Set([
  "completed",
  "failed",
  "failed-resumable",
  "merged",
  "archived",
  "handed-off",
]);

export function parseAgeMs(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const units = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  const result = amount * units[match[2]];
  return Number.isFinite(result) && result > 0 ? result : null;
}

export function terminalTimestamp(state) {
  if (!state || !ARCHIVEABLE_STATUSES.has(state.status)) return null;
  // finishedAt is authoritative. updatedAt keeps legacy terminal records,
  // which did not always record finishedAt, eligible for cleanup.
  for (const value of [state.finishedAt, state.updatedAt]) {
    if (!value) continue;
    const timestamp = new Date(value).getTime();
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return null;
}

export function isArchiveCandidate(state, {
  olderThanMs = DEFAULT_ARCHIVE_AGE_MS,
  now = Date.now(),
} = {}) {
  if (!Number.isFinite(olderThanMs) || olderThanMs <= 0) return false;
  const timestamp = terminalTimestamp(state);
  return timestamp !== null && timestamp <= now - olderThanMs;
}

export function findArchiveCandidates(states, options = {}) {
  return states
    .filter((state) => isArchiveCandidate(state, options))
    .sort((a, b) => terminalTimestamp(a) - terminalTimestamp(b));
}
