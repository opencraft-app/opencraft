// The Python SDK and the Hermes plugin ship the same Agent runtime: vela_im (Python) + the bundled Node worker.
import {cpSync,mkdirSync,rmSync,copyFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const python=join(root,'python-sdk/vela_im');
mkdirSync(join(python,'_worker'),{recursive:true});
copyFileSync(join(root,'sdk/dist/vela-im-worker.mjs'),join(python,'_worker/vela-im-worker.mjs'));
const plugin=join(root,'hermes-plugin/vela_im');
rmSync(plugin,{recursive:true,force:true});
cpSync(python,plugin,{recursive:true,filter:src=>!src.includes('__pycache__')});
console.log('synced Agent runtime into python-sdk and hermes plugin');
