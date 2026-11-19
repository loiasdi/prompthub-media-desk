import { createDouyinClient } from './client.js'
import { createDouyinPublisher } from './publish.js'

export function createDouyinAdapter(config, options) {
  return createDouyinPublisher(createDouyinClient(config, options), options)
}
