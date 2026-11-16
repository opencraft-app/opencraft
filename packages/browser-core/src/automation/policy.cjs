'use strict';

// Self-contained so adapters can apply the same policy in an isolated realm.
function browserControlAttributesAreSensitive(attributes) {
  const type = attributes.type?.trim().toLowerCase() ?? '';
  if (type === 'password' || type === 'hidden') return true;
  const pattern = /(?:pass(?:word|code)?|secret|token|api[-_\s]?key|credential|authorization|cookie|one[-_\s]?time|otp|cc[-_\s]?(?:number|csc|cvv))/iu;
  return Object.values(attributes).some(value => typeof value === 'string' && pattern.test(value));
}
module.exports = { browserControlAttributesAreSensitive };
