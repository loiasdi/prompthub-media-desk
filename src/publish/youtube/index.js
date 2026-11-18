import { createYouTubeClient } from './client.js'
import { createYouTubePublisher } from './publish.js'

// Host-only: HTTP protocol and Google-specific fields do not leak into the workspace.
export function createYouTubeAdapter(config, transport) {
  const client = createYouTubeClient(config, transport)
  return Object.freeze({
    platform: 'youtube',
    authorizationUrl: client.authorizationUrl,
    exchangeCode: client.exchangeCode,
    refreshToken: client.refreshToken,
    ...createYouTubePublisher(client),
  })
}
