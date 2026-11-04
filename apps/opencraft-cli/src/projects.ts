import type { ConversationProjects } from '@opencraft/appserver-protocol/collaboration';
import { CliError } from './errors';

/** Resolve within one authorized Server catalog; never infer a project from cwd. */
export async function resolveProject(selector: string, read: (cursor?: string) => Promise<ConversationProjects>): Promise<string> {
  // Host project identities are UUIDs; preserve direct ID use on large catalogs.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(selector)) return selector;
  let cursor: string | undefined;
  const seen = new Set<string>();
  const matches = new Map<string, string>();
  for (let page = 0; page < 100; page++) {
    const result = await read(cursor);
    if (!result.supported) throw new CliError(6, 'UNSUPPORTED_CAPABILITY', 'Project discovery is unavailable. Use the full project ID.');
    const exact = result.projects.find(project => project.id === selector);
    if (exact) return exact.id;
    for (const project of result.projects) if (project.name === selector) matches.set(project.id, project.name);
    if (result.nextCursor === null) {
      if (matches.size === 1) return matches.keys().next().value!;
      throw new CliError(matches.size ? 5 : 3, matches.size ? 'AMBIGUOUS_PROJECT' : 'UNKNOWN_PROJECT',
        matches.size ? 'Project name is ambiguous. Use --project <full-id>.' : 'Project not found in this Server. Use project list.',
        false, { parameters: ['--project'], projects: [...matches.keys()] });
    }
    if (seen.has(result.nextCursor)) break;
    seen.add(result.nextCursor); cursor = result.nextCursor;
  }
  throw new CliError(5, 'PROJECT_CATALOG_INCOMPLETE', 'Cannot establish a unique project name. Use --project <full-id>.');
}
