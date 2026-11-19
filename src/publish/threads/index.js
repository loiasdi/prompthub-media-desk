import { createThreadsClient } from './client.js'
import { createThreadsPublisher } from './publish.js'

export function createThreadsAdapter(config, options) {
  return createThreadsPublisher(createThreadsClient(config, options), options)
}
