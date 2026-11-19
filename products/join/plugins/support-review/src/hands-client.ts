import { request } from 'node:http';
import { readReviewToken, reviewConfiguration, type ReviewConnection } from './config';
import { REVIEW_INPUT_LIMIT, REVIEW_OUTPUT_LIMIT, REVIEW_TIMEOUT_MS, reviewInput, reviewResult, type ReviewExecutor } from './contract';

/** Private product IPC. No shell commands, file paths or credentials come from the browser. */
export class HandsReviewExecutor implements ReviewExecutor {
  constructor(private readonly configuration: () => Promise<ReviewConnection | null> = () => reviewConfiguration('gateway'), private readonly revision?: string) {
    if(revision!==undefined&&!/^[a-f0-9]{64}$/u.test(revision))throw Error('Invalid review plugin revision');
  }
  async execute(input: Parameters<ReviewExecutor['execute']>[0], current: () => boolean) {
    if (!reviewInput(input)) return null;
    const body = Buffer.from(JSON.stringify(input));
    if (body.length > REVIEW_INPUT_LIMIT) return null;
    try {
      const configuration = await this.configuration();
      if (!configuration) return null;
      const token = await readReviewToken(configuration.tokenFile);
      if (!current()) return null;
      return await new Promise<Awaited<ReturnType<ReviewExecutor['execute']>>>(resolve => {
        let settled = false;
        const finish = (value: Awaited<ReturnType<ReviewExecutor['execute']>>) => {
          if (settled) return; settled = true; clearTimeout(timer); resolve(value);
        };
        // Deliberately one attempt. Lost acknowledgements must not replay approve_send.
        const req = request({ socketPath: configuration.socketPath, path: '/review', method: 'POST', agent: false,
          headers: { ...(this.revision?{'x-opencraft-plugin-revision':this.revision}:{}), authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': body.length } }, res => {
          let bytes = 0; const chunks: Buffer[] = [];
          res.on('error', () => finish(null)); res.on('aborted', () => finish(null));
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > REVIEW_OUTPUT_LIMIT) { finish(null); res.destroy(); } else chunks.push(chunk);
          });
          res.on('end', () => {
            try {
              const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              finish(res.statusCode === 200 && (!this.revision||res.headers['x-opencraft-plugin-revision']===this.revision) && current() && reviewResult(value) ? value : null);
            } catch { finish(null); }
          });
        });
        const timer = setTimeout(() => { finish(null); req.destroy(); }, REVIEW_TIMEOUT_MS + 5000);
        req.on('error', () => finish(null)); req.end(body);
      });
    } catch { return null; }
  }
}
