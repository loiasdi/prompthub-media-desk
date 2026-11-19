import { createBlueskyClient } from './client.js'
import { createBlueskyPublisher } from './publish.js'

export function createBlueskyAdapter(config, options) {
  return createBlueskyPublisher(createBlueskyClient(config, options))
}
