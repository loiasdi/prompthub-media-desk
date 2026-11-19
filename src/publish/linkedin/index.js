import { createLinkedInClient } from './client.js'
import { createLinkedInPublisher } from './publish.js'

export function createLinkedInAdapter(config, options) {
  return createLinkedInPublisher(createLinkedInClient(config, options), options)
}
