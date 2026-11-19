import { createPinterestClient } from './client.js'
import { createPinterestPublisher } from './publish.js'

export function createPinterestAdapter(config, options) {
  return createPinterestPublisher(createPinterestClient(config, options), options)
}
