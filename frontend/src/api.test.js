import test from 'node:test'
import assert from 'node:assert/strict'
import { apiRequest, ApiError } from './api.js'

test('API requests include cookies and encode JSON request bodies', async () => {
  const originalFetch = globalThis.fetch
  let capturedUrl
  let capturedOptions
  globalThis.fetch = async (url, options) => {
    capturedUrl = url
    capturedOptions = options
    return new Response(JSON.stringify({ success: true, user: { id: 'user-1' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const result = await apiRequest('/auth/login', {
      method: 'POST',
      body: { email: 'person@example.com', password: 'passphrase' },
    })
    assert.equal(capturedUrl, 'http://localhost:5000/api/auth/login')
    assert.equal(capturedOptions.credentials, 'include')
    assert.equal(capturedOptions.headers.get('content-type'), 'application/json')
    assert.deepEqual(JSON.parse(capturedOptions.body), {
      email: 'person@example.com',
      password: 'passphrase',
    })
    assert.equal(result.user.id, 'user-1')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('API errors preserve server messages and status codes', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    success: false,
    message: 'Insufficient funds for this transfer',
    code: 'INSUFFICIENT_FUNDS',
  }), {
    status: 409,
    headers: { 'Content-Type': 'application/json' },
  })

  try {
    await assert.rejects(
      apiRequest('/transfers', { method: 'POST', body: {} }),
      (error) => error instanceof ApiError
        && error.status === 409
        && error.code === 'INSUFFICIENT_FUNDS'
        && error.message === 'Insufficient funds for this transfer',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
