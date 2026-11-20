import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {createSchemaValidator} from "@opencraft/sqlite-node";
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
// Preserve SQL string literals (including JSON defaults); normalize only spacing,
// identifier quoting and qualified identifiers in the reviewed legacy forms.
const normalized=(sql:string)=>sql.replace(/'(?:''|[^'])*'|(?:"[A-Za-z0-9_]+"|`[A-Za-z0-9_]+`)\.|["`][A-Za-z0-9_]+["`]|\s+/g,token=>token.startsWith("'")?token:token.endsWith('.')?'':/^["`]/.test(token)?token.slice(1,-1):'');
function checks(sql:string){
 const result:string[]=[];const pattern=/\bCHECK\s*\(/gi;let match:RegExpExecArray|null;
 while((match=pattern.exec(sql))){const start=pattern.lastIndex;let depth=1,index=start;
  for(;index<sql.length&&depth;index++){
   const c=sql[index];if(c==="'"||c==='"'||c==='`'){const delimiter=c;while(++index<sql.length){if(sql[index]===delimiter){if(sql[index+1]===delimiter){index++;continue;}break;}}}
   else if(c==='(')depth++;else if(c===')')depth--;
  }
  assert.equal(depth,0);result.push(normalized(sql.slice(start,index-1)));pattern.lastIndex=index;
 }return result.sort();
}
const sorted=(rows:unknown[])=>rows.map(row=>JSON.stringify(row)).sort();
function signature(db:DatabaseSync,type:string,name:string,sql:string){
 if(type==='table')return{
  options:db.prepare('PRAGMA table_list').all().filter(row=>row.name===name).map(({strict,wr})=>({strict,wr})),
  columns:sorted(db.prepare('PRAGMA table_xinfo('+quote(name)+')').all().map(({name,type,notnull,dflt_value,pk,hidden})=>({name,type,notnull,default:normalized(String(dflt_value)),pk,hidden}))),
  foreign:sorted(db.prepare('PRAGMA foreign_key_list('+quote(name)+')').all().map(({seq,table,from,to,on_update,on_delete,match})=>({seq,table,from,to,on_update,on_delete,match}))),checks:checks(sql),
 };
 const target=/\bON\s+([`"]?)([A-Za-z0-9_]+)\1/i.exec(sql)![2]!;
 return{definition:normalized(sql),properties:db.prepare('PRAGMA index_list('+quote(target)+')').all().filter(row=>row.name===name).map(({unique,origin,partial})=>({unique,origin,partial})),
 columns:db.prepare('PRAGMA index_xinfo('+quote(name)+')').all().map(({seqno,name,desc,coll,key})=>({seqno,name,desc,coll,key}))};
}
/** Keep the strict full-object validator. Only four reviewed, semantically equal
 * legacy CREATE/ALTER representations need catalog-shape comparison first. */
export function assertServerDeclaredSchema(actual:DatabaseSync,declaredSql:string){
 const expected=new DatabaseSync(':memory:');
 try{expected.exec(declaredSql);
  const reviewed=new Set(['actor_human_reservations','actor_human_reservations_alias','personal_assistants','personal_assistants_default_owner_unique']);
  const objects=expected.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,name").all();
  const sql=objects.map(row=>{
   const name=String(row.name);if(!reviewed.has(name))return String(row.sql)+';';
   const stored=actual.prepare('SELECT type,sql FROM sqlite_master WHERE name=?').get(name)!;assert.ok(stored,name);
   assert.equal(stored.type,row.type);assert.deepEqual(signature(actual,String(row.type),name,String(stored.sql)),signature(expected,String(row.type),name,String(row.sql)),name);
   return String(stored.sql)+';';
  }).join('\n');
  createSchemaValidator(sql)(actual);
 }finally{expected.close();}
}
