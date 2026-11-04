import test from "node:test";
import assert from "node:assert/strict";
import {QueryClient, InfiniteQueryObserver} from "@tanstack/react-query";
import {catalogPageTrace, noteCatalogCause, observeCatalogQueries} from "../../apps/workbench-web/src/runtime/catalog-request-observation";
import type {RequestTrace} from "@opencraft/appserver-protocol";

test("Query retries, automatic pages and explicit recovery retain distinct immutable causes",async()=>{
  const client=new QueryClient(), key=["appserver","private-host","threads","scope-a"];
  const traces:RequestTrace[]=[]; let fail=true;
  observeCatalogQueries(client);
  const observer=new InfiniteQueryObserver(client,{queryKey:key,meta:{requestCaller:"sidebar-catalog"},gcTime:0,initialPageParam:null as string|null,retry:1,retryDelay:0,
    queryFn:async({pageParam})=>{
      traces.push(catalogPageTrace(client,key,pageParam));
      if(fail) {fail=false;throw Error("synthetic retry");}
      return {data:[],nextCursor:pageParam === null ? "private-cursor" : null};
    },getNextPageParam:page=>page.nextCursor});
  try {
    await observer.refetch();
    assert.equal(traces.length,2); assert.equal(traces[0].trigger,"initial-load");
    assert.equal(traces[0].traceId,traces[1].traceId);assert.equal(traces[0].parentSpanId,traces[1].parentSpanId);
    assert.notEqual(traces[0].spanId,traces[1].spanId);assert.deepEqual(traces.map(t=>t.attempt),[1,2]);
    noteCatalogCause(client,{queryKey:key,exact:true},"auto-next-page");
    await observer.fetchNextPage({cancelRefetch:false});
    assert.equal(traces[2].trigger,"auto-next-page");assert.equal(traces[2].traceId,traces[0].traceId);assert.equal(traces[2].pageIndex,1);
    noteCatalogCause(client,{queryKey:key,exact:true},"connection-ready");
    noteCatalogCause(client,{queryKey:key,exact:true},"catalog-notification");
    await observer.refetch();
    assert.equal(traces[3].trigger,"connection-ready");assert.notEqual(traces[3].traceId,traces[0].traceId);
    assert.equal(traces[4].traceId,traces[3].traceId);assert.deepEqual(traces.slice(3).map(t=>t.pageIndex),[0,1]);
    assert.equal(traces[0].trigger,"initial-load");
    assert(!JSON.stringify(traces).includes("private"));
  } finally {observer.destroy();client.clear();}
});

test("an invalidation coalesced into an initial fetch does not become a later page's reason",async()=>{
  const client=new QueryClient(),key=["appserver","host","threads"];
  const traces:RequestTrace[]=[];let release!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve);
  observeCatalogQueries(client);
  const observer=new InfiniteQueryObserver(client,{queryKey:key,meta:{requestCaller:"sidebar-catalog"},gcTime:0,initialPageParam:null as string|null,
    queryFn:async({pageParam})=>{traces.push(catalogPageTrace(client,key,pageParam));if(pageParam===null)await gate;return {nextCursor:pageParam===null ? "next" : null};},
    getNextPageParam:p=>p.nextCursor});
  try {
    const first=observer.refetch();
    noteCatalogCause(client,{queryKey:key,exact:true},"connection-ready");
    const duplicate=client.invalidateQueries({queryKey:key,exact:true});
    release();await first;await duplicate;
    noteCatalogCause(client,{queryKey:key,exact:true},"auto-next-page");await observer.fetchNextPage();
    assert.deepEqual(traces.map(t=>t.trigger),["initial-load","auto-next-page"]);
  } finally {release();observer.destroy();client.clear();}
});
