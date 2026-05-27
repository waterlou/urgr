import { subscribeJobSSE } from '../api.js'

export default function waitForJob(jobId) {
  return new Promise((resolve, reject) => {
    subscribeJobSSE(jobId, {
      onResult: (data) => resolve(data),
      onError: (err) => reject(new Error(err)),
      onProgress: () => {},
    })
  })
}
