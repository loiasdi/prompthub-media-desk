import { createKuaishouClient } from './client.js'
import { createKuaishouPublisher } from './publish.js'

export function createKuaishouAdapter(config, options) {
  return createKuaishouPublisher(createKuaishouClient(config, options))
}
