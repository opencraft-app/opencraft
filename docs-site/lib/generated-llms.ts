import fs from 'node:fs/promises';
import path from 'node:path';

const componentIDPattern = /^[a-z0-9-]+$/;

export async function listGeneratedLLMComponents() {
  const dir = path.join(process.cwd(), 'generated', 'llms');
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.txt'))
      .map((entry) => entry.name.slice(0, -4))
      .filter((component) => componentIDPattern.test(component))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function readGeneratedLLMText(component: string) {
  if (!componentIDPattern.test(component)) return undefined;

  try {
    return await fs.readFile(path.join(process.cwd(), 'generated', 'llms', `${component}.txt`), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
