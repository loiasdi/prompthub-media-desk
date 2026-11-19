import { createTikTokClient } from './client.js'
import { createTikTokPublisher } from './publish.js'

export function createTikTokAdapter(config, options) {
  return createTikTokPublisher(createTikTokClient(config, options))
}
