import assert from 'node:assert/strict';
import test from 'node:test';
import { queueFailureFields, withQueueFailureFeedback } from '../../apps/workbench-web/src/queue-operation-feedback';

test('failed queue mutation reports once and preserves rejection for draft/queue recovery', async () => {
  let reject!: (error: Error) => void;
  let reports = 0;
  const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
  const operation = withQueueFailureFeedback(() => pending, () => { reports++; });
  assert.equal(reports, 0);
  const error = new Error('denied'); reject(error);
  await assert.rejects(operation, actual => actual === error);
  assert.equal(reports, 1);
});
test('successful queue mutation preserves result without error notice', async () => {
  const value = await withQueueFailureFeedback(async () => 'deleted', () => assert.fail('unexpected notice'));
  assert.equal(value, 'deleted');
});

test('queue evidence includes only bounded protocol reasons, never raw error payloads', () => {
  const error = Object.assign(new Error("Execution identity is unavailable"), { code: -32600,
    data: { retryable: false, notSubmitted: true, submissionOutcome: "rejected", token: "secret" } });
  assert.deepEqual(queueFailureFields(error), { rpcCode: -32600, reason: "execution-identity-unavailable", retryable: false, notSubmitted: true, submissionOutcome: "rejected" });
  assert.equal(queueFailureFields(new Error("password=secret")).reason, "unclassified");
});
test('feedback receives original failure and cannot mask it', async () => {
  const error = new Error("original");
  await assert.rejects(withQueueFailureFeedback(async () => { throw error; }, received => {
    assert.equal(received, error); throw new Error("diagnostics failed");
  }), actual => actual === error);
});
