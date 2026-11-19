import { createInstagramClient } from './client.js'
import { createInstagramPublisher } from './publish.js'

export function createInstagramAdapter(config, options) {
  return createInstagramPublisher(createInstagramClient(config, options), options)
}
