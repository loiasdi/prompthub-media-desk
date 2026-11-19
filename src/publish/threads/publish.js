import { setTimeout as delay } from 'node:timers/promises'
import { threadsCaption, threadsCopyIssue } from '../draft-copy.js'
import { PublishError } from '../errors.js'
import { THREADS_REPLY } from '../media-rules.js'

const invalid = message => new PublishError('INVALID_THREADS_DRAFT', message, { stage: 'check' })

export function createThreadsPublisher(client, { wait = (ms, signal) => delay(ms, undefined, { signal }), pollAttempts = 5, pollIntervalMs = 60_000 } = {}) {
  function check({ draft, video, cover }) {
    const copyIssue = threadsCopyIssue(draft || {})
    if (copyIssue) throw invalid(copyIssue)
    if (video || cover) throw invalid('Threads 此入口仅支持纯文字，不发送图片或视频')
    if (draft.privacyStatus !== 'account' || typeof draft.isAiGenerated !== 'boolean' || !Object.hasOwn(THREADS_REPLY, draft.replyControl)) throw invalid('请确认 Threads 账号隐私、回复范围和 AI 声明')
    return { text: threadsCaption(draft), reply_control: draft.replyControl, is_made_with_ai: String(draft.isAiGenerated), ...(draft.topics.length && { topic_tag: draft.topics[0] }) }
  }
  return Object.freeze({
    account: (...args) => client.account(...args), check,
    async submit({ accessToken, channelId, draft, video, cover, beforeSubmit, signal }) {
      if (typeof beforeSubmit !== 'function') throw new TypeError('A durable submission checkpoint is required')
      if (channelId !== client.userId) throw invalid('Threads 当前账号与投稿确认单不一致')
      const metadata = check({ draft, video, cover })
      await client.account(accessToken, signal)
      const containerId = await client.create(accessToken, metadata, signal)
      for (let attempt = 0; attempt < pollAttempts; attempt++) {
        if (attempt) await wait(pollIntervalMs, signal)
        let state
        try { state = await client.container(accessToken, containerId, signal) }
        catch { throw new PublishError('THREADS_CONTAINER_UNAVAILABLE', 'Threads 未确认文字容器就绪，未发送发布请求', { stage: 'processing' }) }
        if (state === 'FINISHED') {
          await client.account(accessToken, signal)
          await beforeSubmit(containerId)
          const id = await client.publish(accessToken, containerId, signal)
          let url
          try { ({ url } = await client.post(accessToken, id, signal)) } catch {}
          return { status: 'published', receiptId: id, workId: containerId, url }
        }
        if (state === 'PUBLISHED') {
          try { await beforeSubmit(containerId) }
          catch { throw new PublishError('THREADS_ALREADY_PUBLISHED', 'Threads 报告容器已发布，请在平台核对；不会重新发送', { stage: 'review', outcome: 'unknown' }) }
          return { status: 'published', receiptId: containerId }
        }
        if (state !== 'IN_PROGRESS') throw new PublishError('THREADS_CONTAINER_FAILED', 'Threads 文字容器未就绪，未发送发布请求', { stage: 'processing' })
      }
      throw new PublishError('THREADS_CONTAINER_TIMEOUT', 'Threads 未在等待时间内处理完文字容器，未发送发布请求', { stage: 'processing' })
    },
    async review({ accessToken, channelId, receiptId, workId, signal }) {
      if (channelId !== client.userId) throw invalid('Threads 当前账号与投稿确认单不一致')
      await client.account(accessToken, signal)
      if (!workId) {
        const state = await client.container(accessToken, receiptId, signal)
        if (state === 'PUBLISHED') return { status: 'published', platformState: 'published', receiptId }
        throw new PublishError('THREADS_UNCERTAIN_SUBMISSION', 'Threads 未确认该次发布结果，请在平台核对；不会重新发送', { stage: 'review', outcome: 'unknown' })
      }
      const { url } = await client.post(accessToken, receiptId, signal)
      return { status: 'published', platformState: 'available', receiptId, url }
    },
  })
}
