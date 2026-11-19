import {main} from './install.mjs';
main().then(value=>console.log(JSON.stringify(value)),()=>{console.error('Runtime plugin installation rejected; existing selection was preserved');process.exitCode=1;});
