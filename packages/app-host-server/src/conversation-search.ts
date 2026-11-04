import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

type Value = Record<string, any>;
export class InvalidSearch extends Error { readonly code = -32602; }
const normalized = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
/** Unicode61 handles Latin/code words. Explicit Han characters and adjacent pairs
 * retain useful Chinese recall without a platform-specific native tokenizer. */
export function searchTokens(text: string): string {
  const tokens: string[] = [];
  for (const run of normalized(text).match(/[\p{Script=Han}]+|[^\p{Script=Han}]+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(run)) {
      const chars = [...run]; tokens.push(...chars);
      for (let i=1;i<chars.length;i++) tokens.push(chars[i-1]!+chars[i]!);
    } else tokens.push(...run.match(/[\p{L}\p{N}_]+/gu) ?? []);
  }
  return tokens.join(" ");
}
export function searchableText(value: Value): string {
  const output: string[]=[];
  const visit=(v: unknown, depth=0): void => {
    if(depth>16 || v==null) return;
    if(typeof v==="string") {output.push(v);return;}
    if(Array.isArray(v)) {for(const item of v)visit(item,depth+1);return;}
    if(typeof v!=="object") return;
    const row=v as Value;
    if(["image","image_url","audio","file"].includes(row.type)) return;
    if(row.type==="imageGeneration") { visit(row.revisedPrompt,depth+1); return; }
    for(const key of ["text","content","summary","output","aggregatedOutput","stdout","stderr","command","diff","changes","result","structuredContent","description"])
      if(row[key]!==undefined) {if(key==="structuredContent")output.push(JSON.stringify(row[key]));else visit(row[key],depth+1);}
  };
  visit(value); return output.join("\n");
}
/** SessionSource is an externally tagged union; threadSource is analytics metadata. */
export function sourceKind(source:unknown):string {
  if(typeof source==="string")return source;
  if(!source || typeof source!=="object")return "unknown";
  const value=source as Value,sub=value.subAgent??value.subagent;
  if(sub!==undefined) {
    if(sub==="review")return "subAgentReview";
    if(sub==="compact")return "subAgentCompact";
    if(sub&&typeof sub==="object"&&sub.thread_spawn)return "subAgentThreadSpawn";
    return "subAgentOther";
  }
  return typeof value.type==="string" ? value.type : "unknown";
}
export function searchTerm(value: unknown): {text: string; terms: string[]; match: string} {
  if(typeof value!=="string" || value.trim().length===0 || value.length>512) throw new InvalidSearch("A search query of 1–512 characters is required");
  const text=value.trim(),terms=normalized(text).split(/\s+/u).filter(Boolean);
  const tokens=[...new Set(searchTokens(text).split(" ").filter(Boolean))];
  if(!tokens.length) throw new InvalidSearch("The search query needs letters or numbers");
  return {text,terms,match:tokens.map(t=>'"'+t.replaceAll('"','""')+'"').join(" AND ")};
}
export function searchSnippet(text: string, term: string): {snippet:string;snippetMatchRange:{start:number;end:number}} {
  let start=text.indexOf(term),end=start<0?0:start+term.length;
  if(start<0) {
    const query=normalized(term),index=normalized(text).indexOf(query);
    start=0;
    if(index>=0) {
      // Locate only the matching span. Whole-body offset arrays multiply large
      // tool-output memory; coarse chunks keep mapping work and storage bounded.
      let offset=0,folded=0;
      while(offset<text.length) {
        let next=Math.min(text.length,offset+4096);
        if(next<text.length && /[\uDC00-\uDFFF]/u.test(text[next]!))next--;
        const size=normalized(text.slice(offset,next)).length;
        if(folded+size>index)break;
        offset=next;folded+=size;
      }
      let found=false;
      while(offset<text.length && folded<index+query.length) {
        const char=String.fromCodePoint(text.codePointAt(offset)!),size=normalized(char).length;
        if(!found && folded+size>index){start=offset;found=true;}
        folded+=size;offset+=char.length;end=offset;
      }
      // Include trailing decomposed marks belonging to the final matched glyph.
      while(end<text.length && /\p{M}/u.test(String.fromCodePoint(text.codePointAt(end)!)))end+=String.fromCodePoint(text.codePointAt(end)!).length;
    }
  }
  let begin=Math.max(0,start-40),finish=Math.min(text.length,Math.max(end,start+200));
  if(begin>0 && /[\uDC00-\uDFFF]/u.test(text[begin]!))begin--;
  if(finish<text.length && /[\uDC00-\uDFFF]/u.test(text[finish]!))finish++;
  return {snippet:text.slice(begin,finish),snippetMatchRange:{start:start-begin,end:end-begin}};
}

export class ConversationSearch {
  constructor(readonly database:DatabaseSync,readonly scope:string) { database.function("opencraft_search_contains",{deterministic:true},(value,term)=>{const text=String(value??""),query=String(term??"");return text.includes(query)||normalized(text).includes(query)?1:0;}); }
  version():number { return Number(this.database.prepare("SELECT COALESCE(SUM(revision),0) AS version FROM conversation_catalogs").get()!.version); }
  private changed():void {this.database.prepare("UPDATE conversation_catalogs SET revision=revision+1 WHERE scope=?").run(this.scope);}
  put(threadId:string,recordId:string,revision:number,value:Value,groupId:string|null=null):boolean {
    if(this.database.prepare("SELECT source_revision FROM conversation_search_documents WHERE scope=? AND thread_id=? AND record_id=?").get(this.scope,threadId,recordId)?.source_revision===revision)return false;
    const title=recordId==="thread/metadata" ? String(value.name ?? value.preview ?? ""):"";
    const text=recordId==="thread/metadata" ? String(value.preview ?? ""):searchableText(value);
    const result=this.database.prepare(`INSERT INTO conversation_search_documents(scope,thread_id,record_id,group_id,item_id,type,title,text,title_tokens,text_tokens,source_revision)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope,thread_id,record_id) DO UPDATE SET
      group_id=excluded.group_id,item_id=excluded.item_id,type=excluded.type,title=excluded.title,text=excluded.text,
      title_tokens=excluded.title_tokens,text_tokens=excluded.text_tokens,source_revision=excluded.source_revision
      WHERE source_revision<>excluded.source_revision OR title<>excluded.title OR text<>excluded.text`)
      .run(this.scope,threadId,recordId,groupId,groupId?String(value.id):null,String(value.type==="agentMessage"&&value.phase&&value.phase!=="final_answer" ? "agentActivity":value.type ?? "metadata"),title,text,searchTokens(title),searchTokens(text),revision);
    return Number(result.changes)>0;
  }
  remove(threadId:string,recordId?:string):void {
    this.database.prepare(`DELETE FROM conversation_search_documents WHERE scope=? AND thread_id=? ${recordId===undefined?"":"AND record_id=?"}`).run(this.scope,threadId,...(recordId===undefined?[]:[recordId]));
  }
  invalidate(threadId:string):void {
    this.remove(threadId);this.database.prepare("UPDATE conversation_threads SET search_revision=-1 WHERE scope=? AND id=?").run(this.scope,threadId);this.changed();
  }
  /** Bounded hydration through the authoritative owner; never opens another writer. */
  reindex(threadId:string,readBody:(hash:unknown)=>Value,limit=100):Value {
    if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw new InvalidSearch("Invalid indexing batch size");
    const head=this.database.prepare("SELECT * FROM conversation_threads WHERE scope=? AND id=? AND deleted=0").get(this.scope,threadId);
    if(!head)throw new InvalidSearch("Conversation is unavailable");
    const metadataEvent=this.database.prepare("SELECT revision FROM conversation_events WHERE scope=? AND thread_id=? AND event_key='thread/metadata' AND current=1").get(this.scope,threadId);
    let changed=this.put(threadId,"thread/metadata",Number(metadataEvent?.revision ?? 0),JSON.parse(String(head.metadata)));
    const rows=this.database.prepare(`SELECT e.record_id,e.group_id,e.hash,e.revision FROM conversation_events e
      LEFT JOIN conversation_search_documents d ON d.scope=e.scope AND d.thread_id=e.thread_id AND d.record_id=e.record_id
      WHERE e.scope=? AND e.thread_id=? AND e.current=1 AND e.kind='item' AND (d.id IS NULL OR d.source_revision<>e.revision)
      ORDER BY e.revision LIMIT ?`).all(this.scope,threadId,limit+1);
    for(const row of rows.slice(0,limit))changed=this.put(threadId,String(row.record_id),Number(row.revision),readBody(row.hash),row.group_id as string|null)||changed;
    const complete=rows.length<=limit;
    if(complete)this.database.prepare("UPDATE conversation_threads SET search_revision=revision WHERE scope=? AND id=?").run(this.scope,threadId);
    if(changed)this.changed();
    return {indexed:Math.min(rows.length,limit),complete,revision:Number(head.revision)};
  }
  private limit(value:unknown):number {
    const result=value??30;if(!Number.isSafeInteger(result)||Number(result)<1||Number(result)>200)throw new InvalidSearch("Invalid search page size");return Number(result);
  }
  private decode(cursor:unknown,binding:string,version:number):Value {
    if(cursor==null)return {};
    try {
      if(typeof cursor!=="string"||!cursor.startsWith("conversation-search:")||cursor.length>16384)throw Error();
      const value=JSON.parse(Buffer.from(cursor.slice(20),"base64url").toString());
      if(value.binding!==binding||value.version!==version||!Array.isArray(value.after)||value.after.length!==2
        ||!Number.isFinite(value.after[0])||typeof value.after[1]!=="string")throw Error();return value;
    }catch{throw new InvalidSearch("Search changed; start a new search");}
  }
  search(params:Value,canRead:(threadId:string)=>boolean):Value {
    const query=searchTerm(params.searchTerm),limit=this.limit(params.limit),version=this.version();
    if(params.sortKey!=null&&!['created_at','updated_at','recency_at'].includes(params.sortKey))throw new InvalidSearch("Invalid search sort key");
    if(params.sortDirection!=null&&!['asc','desc'].includes(params.sortDirection))throw new InvalidSearch("Invalid search direction");
    if(params.sourceKinds!=null&&(!Array.isArray(params.sourceKinds)||params.sourceKinds.some((s:unknown)=>typeof s!=="string")))throw new InvalidSearch("Invalid source filter");
    const binding=createHash("sha256").update(JSON.stringify([this.scope,query.text,params.archived===true,params.sourceKinds??[],params.sortKey??null,params.sortDirection??null])).digest("hex");
    const cursor=this.decode(params.cursor,binding,version),ranked=params.sortKey==null;
    const ascending=ranked ? params.sortDirection!=="asc":params.sortDirection==="asc";
    const order=ascending?"ASC":"DESC",compare=ascending?">":"<";
    const column=params.sortKey==='created_at'?"createdAt":params.sortKey==='recency_at'?"recencyAt":"updatedAt";
    const score=ranked?"score":`COALESCE(json_extract(metadata,'$.${column}'),0)`;
    const data:Value[]=[];
    // An ASCII word or an emitted one/two-Han token already proves a literal
    // occurrence. Only phrases/punctuation/long Han combinations need raw checks.
    const literalTerms=query.terms.filter(t=>!/^[a-z0-9]+$/u.test(t) && !(/^\p{Script=Han}{1,2}$/u.test(t)));
    // Scores are materialized while FTS5's MATCH cursor is active. Only then can
    // a window select the best document of each thread. CROSS JOIN keeps literal
    // verification behind FTS rowids even before fresh index statistics exist.
    // ACL precedes publication/paging.
    const sql=`WITH matches AS MATERIALIZED (SELECT rowid,bm25(conversation_search,8.0,1.0) AS score FROM conversation_search WHERE conversation_search MATCH ?),
      candidates AS (SELECT d.id,d.thread_id,t.metadata,m.score,ROW_NUMBER() OVER(PARTITION BY d.thread_id ORDER BY m.score,d.id) AS pick
        FROM matches m CROSS JOIN conversation_search_documents d ON d.id=m.rowid CROSS JOIN conversation_threads t ON t.scope=d.scope AND t.id=d.thread_id
        WHERE d.scope=? AND t.deleted=0 AND t.archived=? ${literalTerms.map(()=>"AND (instr(d.title||char(10)||d.text,?)>0 OR opencraft_search_contains(d.title||char(10)||d.text,?)=1)").join(" ")}),
      selected AS (SELECT *,${score} AS ordering FROM candidates WHERE pick=1)
      SELECT * FROM selected ${cursor.after?`WHERE (ordering,thread_id)${compare}(?,?)`:""} ORDER BY ordering ${order},thread_id ${order}`;
    for(const row of this.database.prepare(sql).iterate(query.match,this.scope,params.archived===true?1:0,...literalTerms.flatMap(t=>[t,t]),...(cursor.after??[]))) {
      const threadId=String(row.thread_id);if(!canRead(threadId))continue;
      const thread=JSON.parse(String(row.metadata)),source=sourceKind(thread.source);
      if(params.sourceKinds?.length && !params.sourceKinds.includes(source) && !(source.startsWith("subAgent")&&params.sourceKinds.includes("subAgent")))continue;
      if(!params.sourceKinds?.length && String(source).startsWith('subAgent'))continue;
      const doc=this.database.prepare("SELECT title,text FROM conversation_search_documents WHERE id=?").get(row.id)!;
      const body=String(doc.text)||String(doc.title);
      const term=query.terms.find(t=>body.includes(t))??query.terms.find(t=>normalized(body).includes(t))??query.terms[0]!;
      data.push({thread,snippet:searchSnippet(body,term).snippet,rank:Number(row.score),ordering:Number(row.ordering)});
      if(data.length>limit)break;
    }
    const selected=data.slice(0,limit),last=selected.at(-1);
    const nextCursor=data.length>limit&&last ? "conversation-search:"+Buffer.from(JSON.stringify({binding,version,after:[last.ordering,last.thread.id]})).toString("base64url"):null;
    return {data:selected.map(({ordering:_ordering,...row})=>row),nextCursor,backwardsCursor:null,searchCoverage:{indexedOnly:true},indexVersion:version};
  }
  occurrences(params:Value,turnCursor:(groupId:string)=>string):Value {
    const query=searchTerm(params.searchTerm),limit=this.limit(params.limit),version=this.version();
    const binding=createHash("sha256").update(JSON.stringify([this.scope,params.threadId,query.text,"occurrences"])).digest("hex"),cursor=this.decode(params.cursor,binding,version);
    const anchor=cursor.after?this.database.prepare("SELECT position FROM conversation_events WHERE scope=? AND thread_id=? AND record_id=? AND current=1").get(this.scope,params.threadId,cursor.after[1]):null;
    if(cursor.after&&!anchor)throw new InvalidSearch("Search anchor is unavailable");
    const data:Value[]=[];
    const literalTerms=query.terms.filter(t=>!/^[a-z0-9]+$/u.test(t) && !(/^\p{Script=Han}{1,2}$/u.test(t)));
    for(const row of this.database.prepare(`SELECT d.*,g.position AS group_position,e.position AS item_position
      FROM conversation_search CROSS JOIN conversation_search_documents d ON d.id=conversation_search.rowid
      JOIN conversation_events e ON e.scope=d.scope AND e.thread_id=d.thread_id AND e.record_id=d.record_id AND e.current=1 AND e.kind='item'
      JOIN conversation_events g ON g.scope=d.scope AND g.thread_id=d.thread_id AND g.record_id='group:'||d.group_id AND g.current=1
      WHERE conversation_search MATCH ? AND d.scope=? AND d.thread_id=? AND d.item_id IS NOT NULL
      ${literalTerms.map(()=>"AND opencraft_search_contains(d.text,?)=1").join(" ")}
      ORDER BY g.position,e.position,d.record_id`).iterate(query.match,this.scope,params.threadId,...literalTerms)) {
      if(cursor.after && (Number(row.group_position)<cursor.after[0] || Number(row.group_position)===cursor.after[0]&&Number(row.item_position)<=Number(anchor!.position)))continue;
      const text=String(row.text),term=normalized(text).includes(normalized(query.text)) ? query.text : query.terms.find(t=>normalized(text).includes(t))??query.terms[0]!;
      data.push({turnId:String(row.group_id),itemId:String(row.item_id),...searchSnippet(text,term),turnCursor:turnCursor(String(row.group_id)),ordering:Number(row.group_position),recordId:String(row.record_id)});
      if(data.length>limit)break;
    }
    const selected=data.slice(0,limit),last=selected.at(-1);
    return {data:selected.map(({ordering:_o,recordId:_r,...row})=>row),nextCursor:data.length>limit&&last ? "conversation-search:"+Buffer.from(JSON.stringify({binding,version,after:[last.ordering,last.recordId]})).toString("base64url"):null};
  }
}
