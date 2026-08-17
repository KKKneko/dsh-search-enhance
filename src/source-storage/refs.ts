import { randomBytes } from 'node:crypto'

import type { SourceRef } from '../contracts/index.js'
import { SOURCE_REF_PATTERN } from './domain.js'

export const SOURCE_REF_RANDOM_BYTES = 24

export type SourceRefEntropy = (size: number) => Uint8Array

/** Create an opaque 192-bit reference that carries no session, query, URL, or credential data. */
export function createSourceRef(entropy: SourceRefEntropy = randomBytes): SourceRef {
  const bytes = entropy(SOURCE_REF_RANDOM_BYTES)
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== SOURCE_REF_RANDOM_BYTES) {
    throw new TypeError(`source ref entropy must return ${SOURCE_REF_RANDOM_BYTES} bytes`)
  }
  return `src_${Buffer.from(bytes).toString('base64url')}` as SourceRef
}

export function isSourceRef(value: unknown): value is SourceRef {
  return typeof value === 'string' && SOURCE_REF_PATTERN.test(value)
}
