/**
 * The engine's native selector language, for nodes the `screen` queries
 * cannot name: space-separated `key=value` terms that all must hold.
 *
 * - `id=SaveButton`: the UI Automation AutomationId, exactly.
 * - `type=Button`: the UI Automation control type, exactly.
 * - `role=button`: the contract role, exactly.
 * - `name="Save as"`: the accessible name, exactly; `name~="save"` contains, case-insensitive.
 *
 * Values with spaces take double quotes; `\"` and `\\` escape inside them.
 * `desktop.locator('type=Edit name~="file name"')`.
 */

import { EngineError, type SemanticNode } from 'e2e/engine';

type Term = { readonly key: 'id' | 'type' | 'role' | 'name'; readonly value: string; readonly contains: boolean };

const TERM = /\s*(id|type|role|name)(~?=)("(?:[^"\\]|\\.)*"|[^\s"]+)/y;

/** Parses a selector; a malformed one is `UNSUPPORTED_CAPABILITY` naming the grammar. */
export function parseSelector(selector: string): Term[] {
  const terms: Term[] = [];
  TERM.lastIndex = 0;
  let at = 0;
  while (at < selector.length && selector.slice(at).trim() !== '') {
    TERM.lastIndex = at;
    const match = TERM.exec(selector);
    if (match === null) throw malformed(selector);
    const [, key, operator, raw = ''] = match;
    const value = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, '$1') : raw;
    if (operator === '~=' && key !== 'name') throw malformed(selector);
    terms.push({ key: key as Term['key'], value, contains: operator === '~=' });
    at = TERM.lastIndex;
  }
  if (terms.length === 0) throw malformed(selector);
  return terms;
}

/** The candidates a selector matches, in document order. */
export function matchSelector(selector: string, candidates: readonly SemanticNode[]): SemanticNode[] {
  const terms = parseSelector(selector);
  return candidates.filter((node) => terms.every((term) => holds(term, node)));
}

function holds(term: Term, node: SemanticNode): boolean {
  switch (term.key) {
    case 'id':
      return node.testId === term.value;
    case 'type':
      return node.attributes?.controlType === term.value;
    case 'role':
      return node.role === term.value;
    case 'name': {
      const name = node.name ?? '';
      return term.contains ? name.toLowerCase().includes(term.value.toLowerCase()) : name === term.value;
    }
  }
}

function malformed(selector: string): EngineError {
  return new EngineError(
    'UNSUPPORTED_CAPABILITY',
    `${JSON.stringify(selector)} is not a desktop selector: use space-separated id=, type=, role=, name= or name~= terms, such as type=Edit name="File name"`,
    { retryable: false },
  );
}
