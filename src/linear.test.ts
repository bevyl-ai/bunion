import { describe, expect, test } from 'bun:test'
import { isRateLimited } from './linear'

// Linear's hourly-quota rejection arrives as HTTP 400 with the 429 buried in the error body — the marker the
// cooldown MUST catch (2026-07-02 quota death spiral). Shape below is a real captured response, trimmed.
const RATELIMITED_BODY = {
  errors: [{
    message: 'Rate limit exceeded. Only 2500 requests are allowed per 1 hour.',
    extensions: { type: 'ratelimited', code: 'RATELIMITED', statusCode: 429, userError: true, http: { status: 400 } },
  }],
}

describe('isRateLimited', () => {
  test('detects RATELIMITED in a 400-wrapped body', () => {
    expect(isRateLimited(RATELIMITED_BODY)).toBe(true)
  })
  test('detects by extensions.type alone', () => {
    expect(isRateLimited({ errors: [{ extensions: { type: 'ratelimited' } }] })).toBe(true)
  })
  test('ordinary GraphQL errors are not rate limits', () => {
    expect(isRateLimited({ errors: [{ message: 'field not found', extensions: { code: 'INVALID_INPUT' } }] })).toBe(false)
  })
  test('non-error and malformed bodies are not rate limits', () => {
    expect(isRateLimited({ data: { ok: true } })).toBe(false)
    expect(isRateLimited(null)).toBe(false)
    expect(isRateLimited({ errors: 'nope' })).toBe(false)
  })
})
