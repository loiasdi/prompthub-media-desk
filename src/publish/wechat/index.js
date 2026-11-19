import { createWeChatClient } from './client.js'
import { createWeChatPublisher } from './publish.js'

export function createWeChatAdapter(config, options) {
  return createWeChatPublisher(createWeChatClient(config, options))
}
