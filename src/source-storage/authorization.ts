import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import type { StoredSourceRecord } from '../contracts/index.js'

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function successfulTopLevelResult(event: SessionEvent, callId: string): boolean {
  if (event.type !== 'tool/result') return false
  if (event.data.error !== undefined) return false
  const block = event.data.message.content[0]
  return block?.type === 'tool-result'
    && String(block.toolCallId) === callId
    && block.isError !== true
}

function successfulCodeDispatch(
  event: SessionEvent,
  record: StoredSourceRecord,
): boolean {
  if (String(event.type) !== 'tool/code-dispatch') return false
  const data: unknown = event.data
  if (!isObject(data)) return false
  return data.isError === false
    && data.rootCallId === record.call.rootCallId
    && data.subCallId === record.call.callId
    && data.name === record.call.name
}

function inheritedEvents(session: Session): readonly SessionEvent[] {
  if (session.header.parentSession === undefined) return []
  const seedLength = session.header.seedLength
  if (!Number.isSafeInteger(seedLength) || seedLength === undefined || seedLength <= 0) return []
  return session.events.slice(0, Math.min(seedLength, session.events.length))
}

/** Authorize the owner immediately, or a fork only through inherited structured success events. */
export function canReadSourceRecord(session: Session, record: StoredSourceRecord): boolean {
  if (String(session.id) === record.ownerSessionId) return true
  const events = inheritedEvents(session)
  if (record.call.mode === 'top-level') {
    return events.some(event => successfulTopLevelResult(event, record.call.callId))
  }
  return events.some(event => successfulCodeDispatch(event, record))
}
