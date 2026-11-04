import { UnsupportedCollaborationCapability } from '@opencraft/appserver-client/collaboration';

export class CliError extends Error {
  constructor(readonly exitCode: number, readonly code: string, message: string, readonly retryable = false, readonly details?: unknown) { super(message); }
}
export function classify(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof UnsupportedCollaborationCapability) return new CliError(6, error.code, 'Host lacks ' + error.capability + '.');
  const fault = error as { code?: string; data?: { code?: string; status?: number }; message?: string; cause?: { message?: string } };
  const code = fault.data?.code, status = fault.data?.status;
  if(code==='thread_count_unavailable')return new CliError(7,'THREAD_COUNT_UNAVAILABLE','Recorded thread count is unavailable. Repeat only this read.');
  if(['text_search_unavailable','text_search_unknown'].includes(code??''))return new CliError(7,code!.toUpperCase(),'Imported public text read is unavailable or unknown. Repeat only this read.');
  if(['text_search_changed','text_search_cursor_invalid'].includes(code??''))return new CliError(5,code!.toUpperCase(),'Source or cursor changed. Start a new text search.');
  if(code==='thread_search_unavailable')return new CliError(7,'THREAD_SEARCH_UNAVAILABLE','Recorded-name search is unavailable. Repeat this read without resending input.');
  if(['thread_search_changed','thread_search_cursor_invalid'].includes(code??''))return new CliError(5,(code!).toUpperCase(),'Directory or cursor changed. Start a new search.');
  if (code === 'THREAD_NOT_FOUND') return new CliError(3,'UNAVAILABLE','Resource unavailable.');
  if (code === 'queue_read_unavailable') return new CliError(7,'QUEUE_READ_UNAVAILABLE','Request observation is unavailable. Repeat this read without resending input.');
  if (code === 'queue_cursor_invalid') return new CliError(5,'QUEUE_CURSOR_INVALID','Cursor is invalid or its Hub restarted. Start a new list.');
  if (code === 'history_read_unavailable') return new CliError(7,'HISTORY_READ_UNAVAILABLE','Target read is unavailable. Repeat this read without resending input.');
  if (code === 'unsupported_capability') return new CliError(6, 'UNSUPPORTED_CAPABILITY', 'Host lacks this capability.');
  if (status === 400) return new CliError(2, (code ?? 'invalid_input').toUpperCase(), 'Invalid input.');
  if (status === 401 || status === 403) return new CliError(4, status === 401 ? 'AUTH_REQUIRED' : 'FORBIDDEN', 'Check your account access.');
  if (status === 404) return new CliError(3, 'UNAVAILABLE', 'Resource unavailable.');
  if (status === 409) return new CliError(5, (code ?? 'conflict').toUpperCase(), code === 'history_changed' ? 'History changed. Start a new page.' : 'State conflict.');
  if (status === 503) return new CliError(8, 'SERVER_UNAVAILABLE', 'Server operation failed.', true);
  if (fault.code === 'TIMEOUT') return new CliError(7, 'TIMEOUT', 'Request timed out.', true);
  if (fault.message?.includes('SSH_AUTH_REQUIRED') || fault.cause?.message?.includes('SSH_AUTH_REQUIRED')) return new CliError(4, 'AUTH_REQUIRED', 'Configure your employee SSH access.');
  return new CliError(7, 'CONNECTION_UNAVAILABLE', 'Connection unavailable.', true);
}
