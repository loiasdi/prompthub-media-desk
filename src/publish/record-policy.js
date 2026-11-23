// Pure record predicates shared by the Host and browser result presentation.
export function retryApproved(record) {
  const value = record?.resolution
  return value?.action === 'confirmed-not-submitted' && typeof value.at === 'string' &&
    typeof value.actor === 'string' && Boolean(value.actor.trim()) && typeof value.reason === 'string' && Boolean(value.reason.trim()) &&
    value.automationStopped === true && value.residualsCleared === true
}

export function snapshotTerminal(record) {
  if (record?.provider !== 'maitian') return false
  if (record.status === 'published') return record.association?.source === 'manual-confirmed' && ['manual-confirmed', 'upstream-matched-id'].includes(record.evidenceSource)
  return ['failed', 'cancelled'].includes(record.status) && (!record.executionIntentAt || retryApproved(record))
}

// Query refreshes do not restart retention. Returning to an uncertain state does.
export function stampSnapshotTerminal(record, at = new Date().toISOString()) {
  if (snapshotTerminal(record)) record.snapshotTerminalAt ||= at
  else delete record.snapshotTerminalAt
}
