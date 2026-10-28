import { createHash } from 'node:crypto';
import { readdir, lstat, readFile, realpath, readlink } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
/** Decode all SQLite rows and JSON declarations, hash opaque attachments and
 * runtime/plugin files. Native compressed history is decoded by the native
 * authority; filesystem hashing alone is never that compatibility proof. */
export async function readDshColdResources({dependencyRoots = [], ...roots}) {
  const files = [];
  const allowed = await Promise.all([...dependencyRoots,...Object.values(roots)].filter(Boolean).map(path=>realpath(path)));
  const visiting = new Set(), directories = new Map(), contents = new Map();
  const visit = async (path,name) => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const target = await realpath(path);
      if (!allowed.some(root=>target === root || target.startsWith(root+sep)) || visiting.has(target)) throw new Error('Unbound DSH resource link: '+name);
      files.push({name,digest:hash(await readlink(path)),link:true});
      visiting.add(target);try {await visit(target,name+'/target');}finally{visiting.delete(target);}return;
    }
    if (!info.isDirectory() && !info.isFile()) throw new Error('Unsupported DSH cold resource: '+name);
    if (info.isDirectory()) {
      if (directories.has(path)) {files.push({name,aliasOf:directories.get(path)});return;}
      directories.set(path,name);
      for (const entry of (await readdir(path)).sort()) {
        if (['.daemon-storage-owner.json','.daemon-storage-owner.lock','host-handoff.json','owner-writer.lock'].includes(entry)
          || entry.endsWith('-wal') || entry.endsWith('-shm')) continue;
        await visit(join(path,entry),join(name,entry));
      }
      return;
    }
    if (contents.has(path)) {files.push({name,...contents.get(path)});return;}
    if (path.endsWith('.sqlite') || path.endsWith('.db')) {
      const db = new DatabaseSync(path,{readOnly:true});
      try {
        if (Object.values(db.prepare('PRAGMA quick_check').get())[0] !== 'ok') throw new Error('DSH store corrupt');
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
        const rows = tables.map(({name})=>({name,rows:db.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"').all()}));
        const content={digest:hash(JSON.stringify(rows,(_,v)=>typeof v === 'bigint' ? String(v) : v))};contents.set(path,content);files.push({name,...content});
      } finally { db.close(); }
    } else {
      const bytes = await readFile(path);
      if (path.endsWith('.json') && !name.split('/').includes('node_modules') && !['nativeRuntime','plugins','skills'].includes(name.split('/')[0]) && (!name.split('/').includes('attachments') || name.endsWith('/manifest.json'))) {
        try { JSON.parse(bytes.toString()); } catch { throw new Error('Invalid DSH store JSON: '+name); }
      }
      const content={digest:hash(bytes),size:bytes.length};contents.set(path,content);files.push({name,...content});
    }
  };
  for (const [name,path] of Object.entries(roots)) if (path) await visit(path,name);
  return files;
}
