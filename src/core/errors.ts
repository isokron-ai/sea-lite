/**
 * Structured rejections. The MCP layer renders `code` + `message` + `details`
 * as an isError tool result; the CLI prints them. Codes are a closed set so
 * an agent can branch on them.
 */

export const ERROR_CODES = [
  'not_found',
  'ambiguous_id',
  'invalid_input',
  'illegal_transition',
  'fence_invalid',
  'fence_foreign_holder',
  'fence_expired',
  'already_claimed',
  'version_conflict',
  'link_exists',
  'cycle',
  'self_loop',
  'forbidden',
  'batch_invalid',
  'nothing_eligible',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class SeaError extends Error {
  override readonly name = 'SeaError';
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }

  toJSON(): { error: ErrorCode; message: string; details: Record<string, unknown> } {
    return { error: this.code, message: this.message, details: { ...this.details } };
  }
}

export function notFound(id: string): SeaError {
  return new SeaError('not_found', `ticket ${id} not found`, { id });
}
