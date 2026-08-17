import { Context } from '@deepseek-ai/cordis'
import {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionStore,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import {
  PersistenceCoordinator,
  SessionFormatUnsupportedError,
  SessionPersistenceRevision,
  type PersistenceBackend,
  type StoredPrefix,
} from '@deepseek-ai/dsh-session-persistence'
import { describe, expect, it } from 'vitest'

const id = SessionId('unknown-required-event-fixture')
const revision = SessionPersistenceRevision('unknown-required-event-revision')

function storedPrefix(): StoredPrefix {
  return {
    meta: {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: 0,
    },
    events: [{
      type: 'search-enhance/unknown-required-fixture',
      seq: 0,
      time: 0,
      data: {},
    } as unknown as SessionEvent],
    revision,
  }
}

function backend(): PersistenceBackend {
  return {
    name: 'unknown-required-event-fixture',
    async loadStored(requestedId) {
      return String(requestedId) === String(id) ? storedPrefix() : undefined
    },
    async readStoredRevision(requestedId) {
      return String(requestedId) === String(id) ? revision : undefined
    },
    async appendBatch() {
      throw new Error('fixture must not append')
    },
    async commitRepair() {
      throw new Error('fixture must not repair')
    },
    async list() {
      return [storedPrefix().meta]
    },
  }
}

describe('official session persistence compatibility guard', () => {
  it('refuses an unknown required event instead of silently reconstructing it', async () => {
    const context = new Context()
    new SessionStore(context)
    const coordinator = new PersistenceCoordinator(context, backend())
    try {
      await expect(coordinator.load(id)).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
      await expect(coordinator.load(id)).rejects.toThrow(/unknown|required|event type/i)
    } finally {
      await context.fiber.dispose()
    }
  })
})
