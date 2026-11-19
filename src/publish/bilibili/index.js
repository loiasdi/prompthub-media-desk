import { createBilibiliClient } from './client.js'
import { createBilibiliPublisher } from './publish.js'

// Composition seam for the Host; credentials never belong to a client-side adapter.
export function createBilibiliAdapter(config, { chunkBytes, ...transport } = {}) {
  const client = createBilibiliClient(config, transport)
  const publisher = createBilibiliPublisher(client, { chunkBytes })
  return Object.freeze({
    platform: 'bilibili',
    authorizationUrl: client.authorizationUrl,
    exchangeCode: client.exchangeCode,
    refreshToken: client.refreshToken,
    account: client.account,
    categories: client.categories,
    check: publisher.check,
    submit: publisher.submit,
    review: publisher.review,
  })
}
