import { Store } from '../../src/store.js'
import { withPublishActivity } from '../../src/publish/activity.js'

await withPublishActivity(new Store(process.argv[2]), 'api-review', async () => {
  process.send({ ready: true })
  await new Promise(resolve => process.once('message', resolve))
})
process.disconnect()
