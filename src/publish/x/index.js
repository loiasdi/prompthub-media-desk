import { createXClient } from './client.js'
import { createXPublisher } from './publish.js'

export function createXAdapter(config, options) {
  return createXPublisher(createXClient(config, options), options)
}
