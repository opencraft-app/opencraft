import { build } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
await build({configFile:false,root:resolve(root,'instance-customizations'),logLevel:'warn',
  resolve:{dedupe:['react','react-dom','react-intl']},build:{target:'esnext',outDir:resolve(process.argv[2]),emptyOutDir:true}});
