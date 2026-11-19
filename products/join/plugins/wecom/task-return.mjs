import { createHash } from 'node:crypto';
import { parseThreadCommand } from '../../../../packages/appserver-protocol/src/thread-command.mjs';

const prefix = 'join:wecom:task-return:';
const terminal = new Set(['completed', 'failed', 'exhausted', 'interrupted_by_user']);
const stateLabels={queued:'已提交，等待执行',starting:'正在启动',active:'执行中',recovering:'恢复中',awaiting_interaction:'等待你的输入',completed:'已完成',failed:'失败',exhausted:'达到运行上限',interrupted_by_user:'已停止',unconfirmed:'状态待确认',superseded:'原轮次已切换'};
/** Per owner+group profile. Only tasks started in this scope can publish back here.
 * Persist the intent before allocation; recover with the original platform idempotency key.
 * Frozen notification text and a stable reply ID make a lost acknowledgement safe to retry. */
export function createTaskReturns({ db, command, reply, authorize, taskFiles, sendFile, taskCard, cliLauncher, now = Date.now, onError = () => {} }) {
  const rows = () => db.prepare('SELECT key,value FROM meta WHERE key LIKE ?').all(prefix + '%').map(r => ({ key: r.key, ...JSON.parse(r.value) }));
  const save = row => db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(row.key, JSON.stringify(row));
  const summary=row=>({taskKey:row.key,title:row.title,reference:row.reference??null,operationId:row.receipt?.operationId??null,
    state:row.executionState??row.phase??'queued',stateSource:'local-tracker',observedAt:row.observedAt??null,
    stopRequested:row.stopRequested===true,deliveryState:row.deliveryState??(row.done?'settled':'pending'),createdAt:row.createdAt});
  async function query(action,key,{offset=0,limit=20}={},signal) {
    await authorize(signal);
    if(action==='list') {
      if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>50)throw Error('Invalid task page');
      const all=rows().sort((a,b)=>b.createdAt-a.createdAt||a.key.localeCompare(b.key));
      await authorize(signal);return {tasks:all.slice(offset,offset+limit).map(summary),nextOffset:offset+limit<all.length?offset+limit:null};
    }
    if(action!=='get')throw Error('Unknown task query');
    const row=rows().find(r=>r.key===key);if(!row)throw Error('Task does not belong to this conversation');
    const result=summary(row);
    if(row.receipt?.operationId) {
      const operation=await command({argv:['thread','operation','show',row.receipt.operationId]},signal);
      result.stateSource='platform';result.observedAt=now();
      result.state=operation.state==='rejected'||operation.input?.deliveryState==='rejected'?'failed':operation.input?.deliveryState==='cancelled'?'interrupted_by_user':'queued';
      if(operation.input?.targetTurnId&&row.reference) {
        const output=await command({argv:['thread','output',row.reference]},signal);
        result.state=output.state?.turnId===operation.input.targetTurnId?output.state.state:'superseded';
      }
    }
    await authorize(signal);return result;
  }
  async function invoke(params, signal) {
    const parsed = parseThreadCommand(params.argv);
    if(parsed.command==='tell'&&parsed.arguments.delivery==='steer') {
      await authorize(signal);
      const candidates=rows().filter(r=>r.reference===parsed.arguments.reference&&r.receipt?.operationId);
      let owner;
      for(const candidate of candidates) {
        const operation=await command({argv:['thread','operation','show',candidate.receipt.operationId]},signal);
        await authorize(signal);
        if(operation.input?.targetTurnId===parsed.arguments.expectedTurnId){owner=candidate;break;}
      }
      if(!owner)throw Error('Live supplement does not match a task turn in this conversation');
      // A steer keeps the original task, export contract and result watcher.
      // Do not append a new delivery directory/CLI contract, allocate another
      // return row/card, or emit the same turn's final result twice.
      const result=await command(params,signal);
      await authorize(signal);
      return {...result,taskKey:owner.key};
    }
    const track = parsed.command === 'start' || (parsed.command === 'tell' && rows().some(r => r.reference === parsed.arguments.reference));
    if (!track) return command(params, signal);
    const key = prefix + createHash('sha256').update(JSON.stringify(params)).digest('hex');
    let row = rows().find(r => r.key === key);
    if (!row) {
      if (rows().filter(r => !r.done&&!r.executionDone).length >= 50) throw Error('Too many pending group tasks');
      let submitted=params;
      if(taskFiles && sendFile) {
        const directory=taskFiles.prepare(key),argv=[...params.argv];
        const index=argv.indexOf(parsed.command==='start'?'--prompt':'--message');
        if(index<0)throw Error('Task prompt required');
        argv[index+1]+='\n\n交付约定：本次来自企业微信，结果会回到原会话。如果本次请求需要生成文件，请仅将应交付给请求人的最终文件复制到 '+directory+' 。不要放入凭据、临时文件、无关文件或符号链接；单文件不超过20 MiB，最多8份。此目录只用于本次交付。无需为了交付额外生成用户未要求的文件。';
        submitted={...params,argv};
      }
      if(cliLauncher){const argv=[...submitted.argv],index=argv.indexOf(parsed.command==='start'?'--prompt':'--message');if(index>=0)argv[index+1]+='\n\n企业微信能力 CLI：'+cliLauncher+' 。这是当前主人/企微会话的私有入口，可直接通过 shell 调用；先运行该路径加 capabilities 或 --help。无需企业微信凭据，不要读取 binding.json，不要寻找或输出任何 token。每次变更必须使用稳定 --idempotency-key，收到接收回执不代表已送达，可用 status 加 messageId 查本会话回执。文件读取和内容分析仍由你自主选工具。';submitted={...submitted,argv};}
      row = { key, params:submitted, originalParams:params, title: parsed.arguments.title ?? '委派任务', createdAt: now(), dueAt: 0 };
      save(row);
    }
    if(row.done && row.receipt)return {...row.receipt,taskKey:row.key};
    const result = await command(row.params ?? params, signal);
    if (!row.done) { row.receipt = result; row.reference = result.reference; save(row); }
    if(taskCard&&!row.cardQueued&&!row.cardStarted) {await taskCard({id:row.key+':queued',taskKey:row.key,title:row.title,state:'queued'},signal);row.cardQueued=true;save(row);}
    return {...result,taskKey:row.key};
  }
  async function poll(signal) {
    for (const row of rows().filter(r => (!r.done || taskCard&&!r.cardFinished || r.snapshotted&&!r.snapshotCleaned) && r.dueAt <= now()).sort((a,b) => a.dueAt-b.dueAt).slice(0,5)) {
      try {
        await authorize(signal);
        if (!row.receipt?.operationId) {
          row.receipt = await command(row.params, signal); row.reference = row.receipt.reference; save(row);
        }
        if (!row.notification) {
          const operation = await command({ argv: ['thread','operation','show',row.receipt.operationId] }, signal);
          row.reference = operation.reference ?? row.reference;
          if (operation.state === 'rejected' || ['rejected','cancelled'].includes(operation.input?.deliveryState)) {
            row.executionDone=true;row.executionState=operation.input?.deliveryState==='cancelled'?'interrupted_by_user':'failed';
            row.notification = `任务未能执行：${row.title}。请在 OpenCraft 中查看任务状态。`;
          } else if (row.reference && operation.input?.targetTurnId) {
            let output = await command({ argv: ['thread','output',row.reference] }, signal);
            const turn = operation.input.targetTurnId;
            if(output.state?.turnId===turn) {
              row.phase=output.state.state;row.observedAt=now();save(row);
              if(taskCard&&!row.cardStarted&&['active','awaiting_interaction'].includes(row.phase)) {
                await taskCard({id:row.key+':running',taskKey:row.key,title:row.title,state:'running'},signal);row.cardStarted=true;save(row);
              }
            }
            if (terminal.has(output.state?.state) && output.state.turnId === turn) {
              // Read bounded pages to reach the final assistant item, not merely the first history page.
              const collected=[...(output.history?.entries??[])];let cursor=output.history?.nextCursor;
              const watermark=output.history?.watermark;
              for(let page=0;cursor && page<100;page++) {
                await authorize(signal);
                const next=await command({argv:['thread','output',row.reference,'--cursor',cursor]},signal);
                if(next.state?.turnId!==turn || next.history?.latestTurnId && next.history.latestTurnId!==turn
                  || watermark && next.history?.watermark!==watermark)throw Error('Task history changed');
                collected.push(...(next.history?.entries??[]));output=next;cursor=next.history?.nextCursor;
              }
              output={...output,history:{...output.history,entries:collected}};
              // A later user turn must never be copied into the original group.
              if (output.history?.latestTurnId && output.history.latestTurnId !== turn) { row.done = true; save(row); continue; }
              const entries = (output.history?.entries ?? []).filter(e => e.role === 'assistant' && e.turnId === turn && typeof e.text === 'string');
              const lastItem=entries.at(-1)?.itemId;
              const body = entries.filter(e=>e.itemId===lastItem).sort((a,b)=>(a.offset??0)-(b.offset??0)).map(e => e.text).join('');
              // A completed state can precede the final history snapshot; wait for it.
              if (output.state.state === 'completed' && !body) {
                row.emptySince ??= now();
                if(now()-row.emptySince<60000) { row.dueAt = now()+15000; save(row); continue; }
              }
              if(taskFiles && sendFile && output.state.state==='completed') {
                row.executionDone=true;row.executionState=output.state.state;save(row);
                const exported=taskFiles.freeze?taskFiles.freeze(row.key):taskFiles.list(row.key); row.files=exported.files;
                row.snapshotted=Boolean(taskFiles.freeze);
                row.fileWarning=exported.skipped.length?'\n部分文件不满足交付条件或在准备交付时已不可用，未自动回传。':'';
              }
              row.executionDone=true;row.executionState=output.state.state;
              const label = { completed:'任务完成', failed:'任务失败', exhausted:'任务已达到运行上限', interrupted_by_user:'任务已停止' }[output.state.state];
              row.notification = `${label}：${row.title}\n\n${body.slice(0,48000)}${body.length>48000 || output.history?.truncated || output.history?.nextCursor ? '\n\n（这里是部分结果，完整内容见任务会话。）' : ''}\n\n任务会话：${row.reference}`;
            } else if (output.state?.turnId && output.state.turnId !== turn && terminal.has(output.state.state)) {
              row.done = true; save(row); continue;
            }
          }
          // Persist exactly what will be sent before touching the native outbox.
          save(row);
        }
        if (row.notification) {
          // Legacy frozen notifications predate execution/delivery separation.
          row.executionDone=true;
          await authorize(signal);
          await reply({ id: row.key, text: row.notification+(row.fileWarning??'') }, signal);
          let retryFiles=false;
          for(const [i,file] of (row.files??[]).entries()) {
            if((row.sentFiles??[]).includes(i)||(row.failedFiles??[]).includes(i))continue;
            await authorize(signal);
            let current;
            try {
              current=row.snapshotted?taskFiles.readDelivery(row.key,file.name):taskFiles.read(row.key,file.name);
              if(current.sha256!==file.sha256 || current.bytes.length!==file.size)throw Error('Task export changed after completion');
            }catch(error){
              if(!['ENOENT','ELOOP'].includes(error.code)&&!/^Task (export|file|delivery)|^Invalid task file/u.test(error.message)){retryFiles=true;onError(error);continue;}
              row.failedFiles=[...(row.failedFiles??[]),i];save(row);onError(error);continue;
            }
            try {
              // Stable IDs preserve native outbox uncertainty semantics. A retry
              // must never allocate a fresh provider send for the same file.
              await sendFile({id:row.key+':file:'+i,name:file.name,bytes:current.bytes},signal);
              row.sentFiles=[...(row.sentFiles??[]),i];save(row);
            }catch(error){retryFiles=true;onError(error);}
          }
          if(row.failedFiles?.length&&!row.fileFailureNotified) {
            await authorize(signal);
            await reply({id:row.key+':file-warning',text:'部分交付文件已不可用，其他文件会继续回传。可以重新执行任务生成文件。'},signal);
            row.fileFailureNotified=true;save(row);
          }
          row.deliveryState=retryFiles?'pending':row.failedFiles?.length?'partial':'delivered';
          row.done=!retryFiles;row.finishedAt??=now();save(row);
          if(row.done&&row.snapshotted&&!row.snapshotCleaned) {
            try{taskFiles.dropDelivery(row.key);row.snapshotCleaned=true;save(row);}catch(error){onError(error);}
          }
          if(taskCard&&!row.cardFinished) {
            const state=row.executionState==='interrupted_by_user'||/^任务已停止/u.test(row.notification)?'stopped':['failed','exhausted'].includes(row.executionState)||/^任务未能执行|^任务失败|^任务已达到运行上限/u.test(row.notification)?'failed':'completed';
            await authorize(signal);
            await taskCard({id:row.key+':finished',taskKey:row.key,title:row.title,state},signal);row.cardFinished=true;
          }
          if(row.done)delete row.params;save(row);
          if(retryFiles){row.dueAt=now()+60000;save(row);continue;}
        }
        row.dueAt = now()+15000; save(row);
      } catch (error) {
        row.dueAt = now()+60000; save(row); onError(error);
      }
    }
  }
  async function control(action,key,eventId,signal) {
    await authorize(signal);const row=rows().find(r=>r.key===key);if(!row)throw Error('Task does not belong to this conversation');
    if(action==='status') {
      const value=await query('get',key,{},signal);
      return '任务「'+row.title+'」：'+(stateLabels[value.state]??'状态待确认')+'。';
    }
    if(action==='stop') {
      if(row.done||row.executionDone)return '任务已经结束。';
      if(!row.receipt?.operationId)throw Error('Task has not started yet; try stopping after admission');
      const operation=await command({argv:['thread','operation','show',row.receipt.operationId]},signal);
      if(!operation.input?.targetTurnId)throw Error('Task has not started yet; try stopping after admission');
      const result=await command({argv:['thread','stop',row.reference,'--expected-turn',operation.input.targetTurnId,'--idempotency-key',eventId]},signal);
      await authorize(signal);
      if(result?.stopped===false&&terminal.has(result.state))return '任务已经'+(result.state==='completed'?'完成':result.state==='interrupted_by_user'?'停止':'结束')+'，没有再次停止。';
      if(result?.stopped!==true||result.turnId!==operation.input.targetTurnId)throw Error('Task stop outcome unconfirmed; query status before retrying');
      row.stopRequested=true;save(row);return '已提交本次任务的停止请求；已经发生的操作不会撤回。';
    }
    if(action==='rerun') {
      if(!row.done&&!row.executionDone)throw Error('Wait for the current task to finish before rerunning');
      const original=row.originalParams;if(!original)throw Error('This older task has no rerun definition');
      const argv=[...original.argv],keyIndex=argv.indexOf('--idempotency-key');
      argv[keyIndex+1]='wecom-rerun-'+createHash('sha256').update(eventId).digest('hex');
      await invoke({...original,argv},signal);return '已重新提交任务。';
    }
    throw Error('Unknown task action');
  }
  // Independent intake and return polling share one profile database. Serialize
  // their read/await/write sequences so a control cannot overwrite delivery state.
  let pending=Promise.resolve();
  const exclusive=work=>{const result=pending.then(work);pending=result.catch(()=>{});return result;};
  return {invoke:(...args)=>exclusive(()=>invoke(...args)),poll:(...args)=>exclusive(()=>poll(...args)),control:(...args)=>exclusive(()=>control(...args)),query:(...args)=>exclusive(()=>query(...args))};
}
