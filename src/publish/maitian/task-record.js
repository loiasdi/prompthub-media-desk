import { executingRecord } from '../records.js'

// Explicit projection: private engine paths, browser sessions and project locations never reach the client.
export function browserRecordView(record) {
  const active = executingRecord(record)
  return {
    provider: 'maitian', taskId: record.taskId, platform: record.platform, status: record.status,
    startedAt: record.startedAt, updatedAt: record.updatedAt, expiresAt: record.expiresAt,
    title: record.plan?.draft?.title || '', account: record.plan?.account?.label || '',
    accountVerification: record.plan?.account?.verification, profileId: record.profileId,
    engineVersion: record.engineVersion, contractVersion: record.contractVersion,
    phase: record.phase, message: record.message,
    executionActive: active, querying: Boolean(record.reviewLease && !record.reviewLease.stoppedAt),
    cancelRequested: Boolean(record.cancelRequestedAt),
    protectionTimedOutAt: record.protectionTimedOutAt,
    canCancel: record.status === 'prepared' || Boolean(record.lease && !record.lease.stoppedAt),
    // Each requested query rediscovers current capabilities; an old missing capability cannot pin a task forever.
    canReview: Boolean(!active && record.executionIntentAt && !record.resolution),
    canReconcile: !active, canOpenManagement: !active,
    canAssociate: Boolean(!active && record.executionIntentAt && !record.resolution && !record.archivedAt),
    canConfirmNotSubmitted: Boolean(!active && !record.archivedAt && !record.resolution && !['published', 'pending_review', 'scheduled'].includes(record.status) && (!record.association || record.association.status === 'rejected')),
    canArchive: !active && !record.archivedAt,
    // A stored reference only permits an exact lookup attempt; existence is checked on open.
    canLocatePage: Boolean(!active && record.runId && !record.archivedAt && !record.resolution), canOpenPage: false,
    reviewError: record.reviewError, lastReview: record.lastReview ? {
      reviewId: record.lastReview.reviewId, source: record.lastReview.source, queriedAt: record.lastReview.queriedAt,
      engineVersion: record.lastReview.engineVersion, result: record.lastReview.result,
      needsConfirmation: record.lastReview.needsConfirmation, matchedAssociatedId: record.lastReview.matchedAssociatedId,
    } : null,
    evidenceSource: record.evidenceSource, url: record.url,
    association: record.association ? { status: record.association.status, workId: record.association.workId, url: record.association.url,
      source: record.association.source, actor: record.association.actor, confirmedAt: record.association.confirmedAt,
      actualScheduleAt: record.association.actualScheduleAt, actualTimezone: record.association.actualTimezone,
      scheduleVerification: record.association.scheduleVerification, scheduleMismatch: record.association.scheduleMismatch } : null,
    archivedAt: record.archivedAt, resolved: Boolean(record.resolution),
  }
}
