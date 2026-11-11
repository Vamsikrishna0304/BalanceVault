const API_BASE_URL = (import.meta.env?.VITE_API_URL || 'http://localhost:5000/api').replace(/\/$/, '')

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers)
  let body = options.body

  if (body !== undefined && typeof body !== 'string') {
    headers.set('Content-Type', 'application/json')
    body = JSON.stringify(body)
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
    body,
    credentials: 'include',
  })
  const payload = await response.json()

  if (!response.ok) {
    throw new ApiError(
      payload.message || 'The request could not be completed',
      response.status,
      payload.code,
    )
  }

  return payload
}
