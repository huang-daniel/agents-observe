import { describe, expect, it } from 'vitest'
import { getWebSocketUrl } from './use-websocket'

describe('getWebSocketUrl', () => {
  it.each([
    ['http:', 'localhost:4981', 'ws://localhost:4981/api/events/stream'],
    ['https:', 'observe.example.com', 'wss://observe.example.com/api/events/stream'],
  ])('uses %s page origins with the matching WebSocket scheme', (protocol, host, expected) => {
    expect(getWebSocketUrl({ protocol, host })).toBe(expected)
  })
})
