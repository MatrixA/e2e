/**
 * Cua Driver refusals onto the engine error contract.
 *
 * | Cua Driver failure                                              | Code                        |
 * | --------------------------------------------------------------- | --------------------------- |
 * | already an EngineError / runner error                           | passed through untouched    |
 * | AbortError, an aborted signal                                   | CANCELLED                   |
 * | a stale or unknown element token, a replaced snapshot           | NODE_STALE (retryable)      |
 * | the element disabled, not visible, outside the window, occluded | NOT_ACTIONABLE              |
 * | background delivery unavailable                                 | NOT_ACTIONABLE, with a hint |
 * | the window or process gone                                      | INVALID_STATE               |
 * | anything else on an input path                                  | ACTION_MAY_HAVE_COMMITTED   |
 * | anything else on a read path                                    | ENGINE_FAILURE              |
 *
 * An input path is one that may have reached the app: the driver refuses
 * before dispatch for every code above, so only an unclassified failure is
 * uncertain, and the runner must not repeat it blindly.
 */

import { ConfigurationError, EngineError, InfrastructureError, TestError } from 'e2e/engine';
import type { DriverToolResult } from './client.ts';

const STALE = new Set(['stale_element_token', 'invalid_element_token', 'stale_observation', 'stale_target', 'stale_bare_row', 'target_changed']);
const NOT_ACTIONABLE = new Set(['element_disabled', 'element_not_visible', 'element_outside_target_window', 'target_occluded', 'background_occluded']);
const GONE = new Set(['window_not_found', 'target_unavailable', 'process_not_found', 'not_found']);

/** Whether a failure already carries its classification. */
function isClassified(cause: unknown): cause is Error {
  if (cause instanceof EngineError || cause instanceof TestError) return true;
  if (cause instanceof ConfigurationError || cause instanceof InfrastructureError) return true;
  return cause instanceof Error && cause.name === 'EngineError';
}

/** The error a refused tool result stands for. `input` marks a call that may have reached the app. */
export function refusal(tool: string, result: DriverToolResult, input: boolean): EngineError {
  const code = result.errorCode ?? codeIn(result.text);
  const text = `${tool}: ${firstLine(result.text) || 'Cua Driver refused the call'}`;
  if (code !== undefined && STALE.has(code)) return new EngineError('NODE_STALE', text, { retryable: true });
  if (code !== undefined && NOT_ACTIONABLE.has(code)) return new EngineError('NOT_ACTIONABLE', text, { retryable: false });
  if (code === 'background_unavailable') {
    return new EngineError('NOT_ACTIONABLE', `${text}. Hint: this control drops background input; use cua({ delivery: 'foreground' })`, {
      retryable: false,
    });
  }
  if (code !== undefined && GONE.has(code)) return new EngineError('INVALID_STATE', text, { retryable: false });
  return new EngineError(input ? 'ACTION_MAY_HAVE_COMMITTED' : 'ENGINE_FAILURE', text, { retryable: false });
}

/** Translates a thrown failure of one tool call. */
export function translate(tool: string, cause: unknown, signal: AbortSignal, input: boolean): Error {
  if (isClassified(cause)) return cause;
  if (signal.aborted || (cause instanceof Error && cause.name === 'AbortError')) {
    return new EngineError('CANCELLED', `${tool} was cancelled`, { retryable: false, cause });
  }
  const text = cause instanceof Error ? cause.message : String(cause);
  const code = codeIn(text);
  if (code !== undefined) return refusal(tool, { text, images: [], isError: true, errorCode: code }, input);
  return new EngineError(input ? 'ACTION_MAY_HAVE_COMMITTED' : 'ENGINE_FAILURE', `${tool}: ${firstLine(text)}`, {
    retryable: false,
    cause,
  });
}

const KNOWN_CODES = [...STALE, ...NOT_ACTIONABLE, ...GONE, 'background_unavailable'];
const CODE_PATTERN = new RegExp(`\\b(${KNOWN_CODES.join('|')})\\b`);

/** A known refusal code the text names, for a result or error that carries none of its own. */
function codeIn(text: string): string | undefined {
  return CODE_PATTERN.exec(text)?.[1];
}

function firstLine(text: string): string {
  return text.trim().split('\n', 1)[0]?.trim() ?? '';
}
