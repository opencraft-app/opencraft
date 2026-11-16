'use strict';
const { failure } = require('./errors.cjs');
const { parseKey } = require('./keyboard.cjs');
function parseRequest(method, input, platform) {
  const fields = { inspect: [], readContext: ['includeSelection', 'maxInlineChars'],
    click: ['ref', 'expectedRevision'], fill: ['ref', 'expectedRevision', 'value'], press: ['key'], scroll: ['x', 'y'], wait: ['text', 'timeoutMs'] };
  const invalid = () => { throw failure('INVALID_ARGUMENT', 'Invalid browser automation arguments'); };
  if (!Object.hasOwn(fields, method) || !input || typeof input !== 'object' || Array.isArray(input)) invalid();
  if (Object.keys(input).some(key => !fields[method].includes(key))) invalid();
  if (['click', 'fill'].includes(method) && (typeof input.ref !== 'string' || input.ref.length > 256
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) invalid();
  if (method === 'fill' && (typeof input.value !== 'string' || input.value.length > 100000)) invalid();
  if (method === 'press') parseKey(input.key, platform);
  if (method === 'scroll' && ![input.x, input.y].every(value => Number.isFinite(value) && Math.abs(value) <= 10000)) invalid();
  if (method === 'wait' && (typeof input.text !== 'string' || !input.text || input.text.length > 10000
    || !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 60000)) invalid();
  if (method === 'readContext' && (input.includeSelection !== undefined && typeof input.includeSelection !== 'boolean'
    || input.maxInlineChars !== undefined && (!Number.isInteger(input.maxInlineChars) || input.maxInlineChars < 1 || input.maxInlineChars > 200000))) invalid();
  return Object.freeze(Object.fromEntries(fields[method].filter(key => input[key] !== undefined).map(key => [key, input[key]])));
}
module.exports = { parseRequest };
