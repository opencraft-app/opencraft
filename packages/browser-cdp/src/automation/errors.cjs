'use strict';
function failure(code, message, outcome = 'not-dispatched') {
  return Object.assign(new Error(message), { code, retryable: false, outcome });
}
module.exports = { failure };
