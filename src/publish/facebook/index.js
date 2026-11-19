import { createFacebookClient } from './client.js'
import { createFacebookPublisher } from './publish.js'

export function createFacebookAdapter(config, options) {
  return createFacebookPublisher(createFacebookClient(config, options))
}
