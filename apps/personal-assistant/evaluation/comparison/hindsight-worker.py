"""JSONL boundary around the pinned upstream Hindsight engine; no memory policy here."""
import asyncio
import contextlib
import datetime
import json
import os
import signal
import sys
import traceback

engine = None
postgres = None
request_context = None


async def dispatch(req):
    global engine, postgres, request_context
    if req["op"] == "init":
        directory = req["directory"]
        os.makedirs(directory, exist_ok=True)
        os.environ.update({
            "HINDSIGHT_API_LLM_PROVIDER": "openai",
            "HINDSIGHT_API_LLM_API_KEY": "local-comparison",
            "HINDSIGHT_API_LLM_MODEL": req["model"],
            "HINDSIGHT_API_LLM_BASE_URL": req["bridge"] + "/v1",
            "HINDSIGHT_API_LLM_MAX_CONCURRENT": "1",
            "HINDSIGHT_API_LLM_MAX_RETRIES": "1",
            "HINDSIGHT_API_LLM_TIMEOUT": "120",
            "HINDSIGHT_API_EMBEDDINGS_PROVIDER": "openai",
            "HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY": "local-comparison",
            "HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL": req["embedding"] + "/v1",
            "HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL": "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
            "HINDSIGHT_API_EMBEDDINGS_OPENAI_DIMENSIONS": "384",
            "HINDSIGHT_API_RERANKER_PROVIDER": "rrf",
            "HINDSIGHT_API_ENABLE_OBSERVATIONS": "true",
            "HINDSIGHT_API_CONSOLIDATION_RECONCILE_INTERVAL_SECONDS": "0",
        })
        from pg0 import Pg0
        from hindsight_api import MemoryEngine, RequestContext
        from hindsight_api.engine.task_backend import SyncTaskBackend
        postgres = Pg0(name="benchmark", data_dir=os.path.join(directory, "postgres"))
        info = await asyncio.to_thread(postgres.start)
        # pg0's status probe can omit uri under this container's process restrictions.
        # The explicit local connection is verified by the real engine migrations.
        if not info.port:
            raise RuntimeError("pg0 did not report its allocated port")
        db_url = info.uri or f"postgresql://postgres:postgres@127.0.0.1:{info.port}/postgres"
        engine = MemoryEngine(db_url=db_url, task_backend=SyncTaskBackend(),
                              pool_min_size=2, pool_max_size=8, skip_llm_verification=True)
        await engine.initialize()
        request_context = RequestContext()
        return {"ready": True, "backend": "upstream-memory-engine", "observations": True,
                "reranker": "rrf", "embeddingDimensions": 384}
    if req["op"] == "add":
        # JSON role labels are the source transcript, not instructions to the learner.
        content = json.dumps(req["messages"], ensure_ascii=False)
        ids, usage = await engine.retain_batch_async(
            bank_id="subject", contents=[{
                "content": content,
                "context": "A conversation between the user and their assistant. Preserve who said each fact.",
                "event_date": datetime.datetime.fromisoformat(req["timestamp"].replace("Z", "+00:00")),
            }], request_context=request_context, return_usage=True)
        return {"unitIds": ids, "usage": usage.model_dump(mode="json")}
    if req["op"] == "search":
        from hindsight_api.engine.response_models import Budget
        recalled = await engine.recall_async(
            bank_id="subject", query=req["query"], budget=Budget.MID, max_tokens=4096,
            prefer_observations=None, include_chunks=False, include_entities=False,
            request_context=request_context)
        return recalled.model_dump(mode="json")
    if req["op"] == "snapshot":
        return await engine.list_memory_units(bank_id="subject", limit=10000,
                                              request_context=request_context)
    if req["op"] == "close":
        await shutdown()
        return {"closed": True}
    raise ValueError("Unknown operation")


async def shutdown():
    global engine, postgres
    try:
        if engine:
            await engine.close()
            engine = None
    finally:
        if postgres:
            await asyncio.to_thread(postgres.stop)
            postgres = None


async def main():
    task = asyncio.current_task()
    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, task.cancel)
    try:
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                break
            req = json.loads(line)
            try:
                with contextlib.redirect_stdout(sys.stderr):
                    result = await dispatch(req)
                print(json.dumps({"id": req["id"], "ok": True, "result": result}, default=str), flush=True)
            except Exception as e:
                traceback.print_exc(file=sys.stderr)
                print(json.dumps({"id": req["id"], "ok": False, "error": type(e).__name__,
                                  "message": str(e)[:300]}), flush=True)
            if req["op"] == "close":
                break
    finally:
        with contextlib.redirect_stdout(sys.stderr):
            await shutdown()


if __name__ == "__main__":
    asyncio.run(main())
