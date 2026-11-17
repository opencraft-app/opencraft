import type { LocalAgentConversation } from '@opencraft/appserver-protocol';

export function groupAgentHistory(conversations: readonly LocalAgentConversation[]) {
  const unique = [...new Map(conversations.map(entry => [entry.id, entry])).values()];
  const groups = new Map<string, { id: string; name: string | null; path: string; position: number; conversations: LocalAgentConversation[] }>();
  for (const entry of unique) {
    const project = entry.nativeProject;
    const id = project ? `project:${project.id}` : entry.cwd ? `cwd:${entry.cwd}` : 'ungrouped';
    let group = groups.get(id);
    if (!group) {
      group = { id, name: project?.name ?? (entry.cwd.split(/[\\/]/u).filter(Boolean).at(-1) || entry.cwd || null), path: entry.cwd,
        position: project?.position ?? Number.MAX_SAFE_INTEGER, conversations: [] };
      groups.set(id, group);
    }
    group.conversations.push(entry);
  }
  return [...groups.values()].sort((a, b) => a.position - b.position);
}


/** Resume-style projection; selection is owned by ID independently of filtering/sorting. */
export function filterAgentHistory(entries: readonly LocalAgentConversation[], search: string, sort: "updated" | "created") {
  const query=search.trim().toLocaleLowerCase();
  const timestamp=(entry:LocalAgentConversation)=>Date.parse((sort==='created'?entry.createdAt:entry.updatedAt)??'')||0;
  return entries.filter(entry=>!query||[entry.title,entry.cwd,entry.id].some(value=>value?.toLocaleLowerCase().includes(query)))
    .sort((a,b)=>timestamp(b)-timestamp(a)||a.id.localeCompare(b.id));
}
