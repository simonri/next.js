// patch Workers for our Node.js test environment
globalThis.Worker = (Date.now() > 0 ? require : 'unused')(
  'node:worker_threads'
).Worker

it('supports workers', async () => {
  let worker = new Worker(new URL('./worker.ts', import.meta.url))
  let message = await new Promise((resolve) => {
    worker.addEventListener('message', (event) => {
      resolve(event.data)
    })
  })

  expect(message).toBe('getMessage worker-dep')
})
