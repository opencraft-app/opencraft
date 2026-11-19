import { readFile } from 'node:fs/promises';
import { packageVelaInstance } from './package-vela-instance.mjs';
const [source,output,sourceRevision,config]=process.argv.slice(2);
console.log(JSON.stringify(await packageVelaInstance({source,output,sourceRevision,configuration:config?JSON.parse(await readFile(config,'utf8')):{}})));
