import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { currentWorkspace } from '../content-assets.js'
import { fail, sourceCopy } from '../workspace-schema.js'
import { PublishError } from './errors.js'
import { withLocalUploadSource } from './local-source.js'
import { PUBLISH_PLATFORMS, publishFormats, publishSelectionIssue, publishUsesArticleImages, publishUsesCover } from './capabilities.js'
import { articleImageIds, articleImageSyntaxIssue } from './article-images.js'
import { accountOf, canReviewPlatform, categoriesOf, categoryTitleOf, platformDraft } from './platforms.js'
import { activeRecord, readPublishRecords, visibleRecord, writePublishRecords } from './records.js'
import { assetSummary, inspectSelection } from './snapshot.js'
import { PublishConfig } from './config.js'

const PREPARED_MS = 15 * 60_000
const EXECUTE_MS = 45 * 60_000
const blocked = new Set(['publishing', 'pending_review', 'unknown', 'published'])
const idPattern = /^[\w-]{1,160}$/
const taskPattern = /^[a-f0-9-]{36}$/
const canReview = job => Boolean(job?.receiptId && ['pending_review', 'unknown', 'published'].includes(job.status) && canReviewPlatform(job))
const exposed = record => record && {
  taskId: record.taskId, platform: record.platform, status: record.status, startedAt: record.startedAt, updatedAt: record.updatedAt,
  receiptId: record.receiptId, canReview: canReview(record), url: record.url, actualPrivacy: record.actualPrivacy, message: record.message, reviewError: record.reviewError,
  ...(record.coverResult && { coverResult: record.coverResult }),
  ...(record.plan.draft.destination && { destination: record.plan.draft.destination }),
  title: record.plan.draft.title, account: record.plan.account.name,
}
const failureMessage = (err, fallback) => err instanceof PublishError || (err.status >= 400 && err.status < 500) ? err.message : fallback

export class Publishing {
  constructor(store, { resolvePlatform, snapshotRoot = tmpdir() } = {}) {
    this.store = store
    this.config = new PublishConfig()
    this.resolvePlatform = resolvePlatform || (platform => this.config.resolve(platform))
    this.snapshotRoot = snapshotRoot
  }

  async locked(run) {
    return this.store.run(async () => {
      await this.store.refresh()
      const root = this.store.root
      return run(await readPublishRecords(root), root)
    })
  }

  platform(platform, required = true) {
    if (!Object.hasOwn(PUBLISH_PLATFORMS, platform)) throw fail('这个平台仅支持手动发布')
    const config = this.resolvePlatform(platform)
    if (required && !config) throw fail('此平台尚未配置并启用本地投稿', 409)
    return config
  }

  item(id) {
    if (typeof id !== 'string' || !idPattern.test(id)) throw fail('内容 ID 无效')
    const item = this.store.state.items.find(row => row.id === id)
    if (!item) throw fail('内容不存在', 404)
    return item
  }

  async status(id) {
    return this.locked(records => {
      const item = this.item(id)
      const platforms = Object.fromEntries(Object.keys(PUBLISH_PLATFORMS).map(key => [key, !item.sample && !item.trashedAt && Boolean(this.platform(key, false))]))
      const jobs = records.filter(record => record.itemId === id && record.status !== 'prepared').slice(-20).reverse().map(record => exposed(visibleRecord(record)))
      // Do not omit an older blocking record just because the visible history is bounded.
      const lockedPlatforms = Object.fromEntries(Object.keys(PUBLISH_PLATFORMS).map(key => [key, records.some(record => record.itemId === id && record.platform === key && blocked.has(record.status))]))
      return { platforms, jobs, lockedPlatforms }
    })
  }

  async options(platform) {
    const config = this.platform(platform)
    const account = await accountOf(platform, config)
    return { account: account.name, categories: await categoriesOf(platform, config), ...(account.constraints && { constraints: account.constraints }) }
  }

  async plan(root, item, revision, platform, adapter, options, account, categoryTitle, snapshotDir) {
    if (item.sample || item.trashedAt) throw fail('示例和回收站内容不能投稿')
    const ws = currentWorkspace(item)
    if (!Number.isInteger(revision) || ws.revision !== revision) throw fail('发布信息已变化，请重新检查', 409)
    const copy = { ...ws.publish }
    const base = sourceCopy(item)
    for (const key of ['title', 'description', 'platform', 'tags']) if (!ws.publishEdited?.[key]) copy[key] = base[key]
    if (copy.platform !== PUBLISH_PLATFORMS[platform].name || !publishFormats(platform).includes(copy.format) || copy.mode !== 'now') throw fail(publishSelectionIssue(platform))
    const draft = platformDraft(platform, copy, options)
    const video = copy.format === 'video' ? await inspectSelection(root, item.id, ws, ws.selectedVideo, 'video', snapshotDir) : undefined
    const images = []
    const articleImages = publishUsesArticleImages(platform, copy.format)
    if (articleImages && articleImageSyntaxIssue(copy.description)) throw fail(articleImageSyntaxIssue(copy.description))
    if (copy.format === 'images' || articleImages) {
      const maxImages = PUBLISH_PLATFORMS[platform].maxImages
      const ids = articleImages ? articleImageIds(copy.description) : ws.imageIds
      if (!Number.isInteger(maxImages) || !Array.isArray(ids) || ids.length < (articleImages ? 0 : 1) || ids.length > maxImages || new Set(ids).size !== ids.length) throw fail('请检查发布图片数量，不能重复选择图片')
      for (const [index, id] of ids.entries()) images.push(await inspectSelection(root, item.id, ws, id, 'image', snapshotDir, index))
    }
    const useCover = publishUsesCover(platform, copy.format) && Boolean(ws.selectedCover)
    const cover = useCover ? await inspectSelection(root, item.id, ws, ws.selectedCover, 'image', snapshotDir, undefined, { maxBytes: PUBLISH_PLATFORMS[platform].coverBytes }) : undefined
    try { adapter.check({ draft, video, cover, images, account }) } catch (err) {
      if (err instanceof PublishError) throw fail(err.message)
      throw err
    }
    return { plan: { revision, draft, account, categoryTitle, video: video ? assetSummary(video) : null, cover: cover ? assetSummary(cover) : null, ...(images.length ? { images: images.map(assetSummary) } : {}) }, video, cover, images }
  }

  async prepare({ id, revision, platform, options } = {}) {
    const config = this.platform(platform)
    await this.locked(records => {
      const item = this.item(id)
      if (item.sample || item.trashedAt) throw fail('示例和回收站内容不能投稿')
      if (records.some(record => record.itemId === id && record.platform === platform && blocked.has(record.status))) throw fail('此稿件已有该平台的投稿记录，请先查看结果', 409)
    })
    const account = await accountOf(platform, config)
    const categoryTitle = await categoryTitleOf(platform, config, options?.categoryId)
    return this.locked(async (records, root) => {
      if (records.some(record => record.itemId === id && record.platform === platform && blocked.has(record.status))) throw fail('此稿件已有该平台的投稿记录，请先查看结果', 409)
      const { plan } = await this.plan(root, this.item(id), revision, platform, config.adapter, options, account, categoryTitle)
      const taskId = randomUUID()
      const expiresAt = Date.now() + PREPARED_MS
      const keep = records.filter(record => record.status !== 'prepared' || (record.expiresAt > Date.now() && (record.itemId !== id || record.platform !== platform)))
      await writePublishRecords(root, [...keep, { itemId: id, platform, taskId, status: 'prepared', expiresAt, plan }])
      const { id: _accountId, ...publicAccount } = plan.account
      return { taskId, expiresAt, ...plan, account: publicAccount }
    })
  }

  async start({ id, taskId, confirmed } = {}) {
    if (confirmed !== true || typeof taskId !== 'string' || !taskPattern.test(taskId)) throw fail('须明确确认当前投稿单')
    const find = records => {
      const record = records.find(row => row.itemId === id && row.taskId === taskId)
      if (!record) throw fail('投稿单不存在或已被替换，请重新检查', 409)
      return record
    }
    const checked = await this.locked(records => find(records))
    if (checked.status !== 'prepared') return exposed(visibleRecord(checked))
    if (checked.expiresAt <= Date.now()) throw fail('投稿单已过期，请重新检查', 409)
    const platform = checked.platform
    const config = this.platform(platform)
    const account = await accountOf(platform, config)
    if (checked.plan.account.id !== account.id) throw fail('发布账号已更换，请重新检查', 409)
    const categoryTitle = await categoryTitleOf(platform, config, String(checked.plan.draft.categoryId), true)
    let dir, claim
    try {
      claim = await this.locked(async (records, root) => {
        const record = find(records)
        if (record.status !== 'prepared') return { existing: exposed(visibleRecord(record)) }
        if (record.expiresAt <= Date.now() || records.some(row => row !== record && row.itemId === id && row.platform === platform && blocked.has(row.status))) throw fail('投稿单已过期或已有尝试，请重新检查', 409)
        dir = await mkdtemp(join(this.snapshotRoot, 'media-desk-publish-'))
        const { draft, revision } = record.plan
        const next = await this.plan(root, this.item(id), revision, platform, config.adapter, { ...draft, categoryId: String(draft.categoryId) }, account, categoryTitle, dir)
        if (JSON.stringify(next.plan) !== JSON.stringify(record.plan)) throw fail('文案、账号或素材已变化，请重新检查', 409)
        if (record.expiresAt <= Date.now()) throw fail('投稿单已过期，请重新检查', 409)
        record.status = 'publishing'
        record.startedAt = record.updatedAt = new Date().toISOString()
        record.deadline = Date.now() + EXECUTE_MS
        await writePublishRecords(root, records)
        return { record, video: next.video, cover: next.cover, images: next.images }
      })
    } catch (err) {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
      throw err
    }
    if (claim.existing) return claim.existing
    void this.execute(claim, config, dir).catch(() => {})
    return exposed(claim.record)
  }

  async updateClaim(taskId, mutate) {
    return this.locked(async (records, root) => {
      const record = records.find(row => row.taskId === taskId)
      if (!record || record.status !== 'publishing') throw fail('投稿任务状态已改变', 409)
      mutate(record)
      record.updatedAt = new Date().toISOString()
      await writePublishRecords(root, records)
    })
  }

  async execute({ record, video, cover, images = [] }, { adapter, accessToken }, dir) {
    const signal = AbortSignal.timeout(Math.max(1, record.deadline - Date.now()))
    let checkpoint = false
    try {
      const submit = (v, c, localImages) => adapter.submit({
        accessToken, channelId: record.plan.account.id, draft: record.plan.draft, video: v, cover: c, images: localImages, signal,
        beforeSubmit: async receiptId => {
          await this.updateClaim(record.taskId, value => {
            if (!activeRecord(value) || signal.aborted) throw fail('投稿任务已超时', 409)
            value.submissionStarted = true
            if (typeof receiptId === 'string') value.receiptId = receiptId
            else if (receiptId && typeof receiptId.receiptId === 'string') {
              value.receiptId = receiptId.receiptId
              if (receiptId.coverResult?.status === 'pending') value.coverResult = { status: 'pending' }
            }
          })
          checkpoint = true
        },
      })
      const withImages = (video, cover, index = 0, opened = []) => index === images.length ? submit(video, cover, opened)
        : withLocalUploadSource(dir, images[index].destination, images[index], image => withImages(video, cover, index + 1, [...opened, { ...image, id: images[index].id }]))
      const result = video ? await withLocalUploadSource(dir, video.destination, video, v => cover
        ? withLocalUploadSource(dir, cover.destination, cover, c => withImages(v, c)) : withImages(v)) : cover ? await withLocalUploadSource(dir, cover.destination, cover, c => withImages(undefined, c)) : await withImages()
      await this.updateClaim(record.taskId, row => Object.assign(row, {
        status: ['pending_review', 'published'].includes(result.status) && result.receiptId ? result.status : 'unknown', receiptId: result.receiptId ?? row.receiptId, workId: result.workId,
        ...(result.mediaIds && { mediaIds: result.mediaIds }),
        ...(result.coverResult && { coverResult: result.coverResult }),
        url: result.url, actualPrivacy: result.privacyStatus,
      }))
    } catch (err) {
      const unknown = err.outcome === 'unknown' || (checkpoint && !(err instanceof PublishError && err.outcome === 'failed'))
      await this.updateClaim(record.taskId, row => Object.assign(row, {
        status: unknown ? 'unknown' : 'failed',
        message: failureMessage(err, unknown ? '无法确认投稿结果，请先在平台创作中心核对。' : '投稿未完成，请检查素材与账号再试。'),
      })).catch(() => {})
    } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}) }
  }

  async review({ id, taskId } = {}) {
    const job = await this.locked(records => records.find(row => row.itemId === id && row.taskId === taskId))
    if (!job || !canReview(visibleRecord(job))) throw fail('此投稿不能在线回查，请在平台创作中心核对', 409)
    let result, error
    try {
      const config = this.platform(job.platform)
      const account = await accountOf(job.platform, config, undefined, { review: true })
      if (account.id !== job.plan.account.id) throw fail('当前账号不是原投稿账号', 409)
      result = await config.adapter.review({ accessToken: config.accessToken, channelId: account.id, receiptId: job.receiptId, workId: job.workId, mediaIds: job.mediaIds, format: job.plan.draft.format, destination: job.plan.draft.destination, privacyStatus: job.plan.draft.privacyStatus, images: job.plan.images })
    } catch (err) { error = failureMessage(err, '本次回查未成功，请稍后再试') }
    return this.locked(async (records, root) => {
      const record = records.find(row => row.taskId === taskId && row.itemId === id)
      if (!record) throw fail('找不到投稿记录', 404)
      if (record.reviewVersion !== job.reviewVersion || record.status !== job.status) return exposed(visibleRecord(record))
      record.reviewVersion = (record.reviewVersion || 0) + 1
      record.updatedAt = new Date().toISOString()
      record.reviewError = error
      if (result?.status === 'unknown' && result.platformState === undefined) {
        record.reviewError = '平台未返回可确认的作品状态，已保留原投稿记录。'
      } else if (result) {
        if (['pending_review', 'unknown', 'published', 'failed', 'rejected'].includes(result.status)) record.status = result.status
        record.actualPrivacy = result.privacyStatus
        if (result.url || result.status !== 'published') record.url = result.url
        record.message = undefined
      }
      await writePublishRecords(root, records)
      return exposed(visibleRecord(record))
    })
  }
}
