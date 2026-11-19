import React, {useState} from 'react';
import {IntlProvider} from 'react-intl';
import messages from '../../plugins/tencentoa/src/locales/zh-CN.json';
import * as themes from '@opencraft/design-system/theme-engine';
import {createIntlTestRoot} from '../../../../tests/fixtures/intl-root';
import {EmployeeGitConnectionForm} from '../../plugins/tencentoa/src/git-credentials-view';
import type {EmployeeGitSnapshot,EmployeeGitInput} from '../../plugins/tencentoa/src/git-credentials-contract';
import '../../../../apps/workbench-web/src/styles/app.scss';
const query=new URLSearchParams(location.search);
document.documentElement.dataset.theme='light';
for(const [key,value] of Object.entries(themes.buildOpenCraftThemeCssProperties('light',themes.opencraftNeutralThemePalette.light)))document.documentElement.style.setProperty(key,value);
const initial:EmployeeGitSnapshot={scope:'fixture',gongfengMcp:{revision:1,configured:query.has('mcp')},hosts:Object.fromEntries(['git.woa.com','github.com'].map(host=>[host,{revision:1,configured:true,tokenConfigured:host==='github.com',identity:{username:'fixture',name:'Fixture',email:'fixture@example.test'},sshAuth:query.has('ssh')?{generation:'one',fingerprint:'fixture-fingerprint',publicKey:'ssh-ed25519 fixture-public-key'}:null,signing:null}])) as EmployeeGitSnapshot['hosts']};
const calls:EmployeeGitInput[]=[];(window as any).gitCalls=calls;
function Fixture(){const [snapshot,setSnapshot]=useState(initial);const load=async(input?:EmployeeGitInput)=>{if(!input)return true;calls.push(input);if(input.action==='generate-ssh')setSnapshot({...snapshot,hosts:{...snapshot.hosts,[input.host]:{...snapshot.hosts[input.host],revision:2,sshAuth:{generation:'two',fingerprint:'fixture-fingerprint',publicKey:'ssh-ed25519 fixture-public-key'}}}});return true};return <EmployeeGitConnectionForm host={query.has('github')?'github.com':'git.woa.com'} controller={{snapshot,busy:false,unauthorized:false,operationErrors:{},operationCodes:{},clearHostErrors(){},load,getSnapshot:()=>snapshot}}/>}
createIntlTestRoot(document.getElementById('root')!,undefined,'zh-CN').render(<IntlProvider locale="zh-CN" messages={messages}><div style={{padding:16}}><Fixture/></div></IntlProvider>);
