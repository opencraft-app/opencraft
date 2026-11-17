import {isAbsolute,join} from 'node:path';
const path=value=>{if(typeof value!=='string'||!isAbsolute(value)||value.trim()!==value||/[\x00-\x1f\x7f]/.test(value))throw new Error('Invalid machine service path');return value;};
const spec=value=>value.replace(/%/g,'%%');
const argument=value=>'"'+spec(value).replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\$/g,'$$')+'"';
export function machineServiceUnit(state,executable){
 path(state);path(executable);
 return '[Unit]\nDescription=OpenCraft personal machine\n[Service]\nWorkingDirectory='+spec(join(state,'runtime'))+'\nExecStart='+[executable,join(state,'launcher.mjs'),'--state',state].map(argument).join(' ')+'\nRestart=on-failure\nRestartSec=5\nKillMode=mixed\nTimeoutStopSec=60\n[Install]\nWantedBy=default.target\n';
}
