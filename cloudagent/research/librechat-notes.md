# LibreChat request-surface notes

Date: 2026-05-18

Scope: read-only inspection of LibreChat cloned at `research/LibreChat`, plus the exact npm packages pinned by that checkout. LibreChat source was not modified.

## What was checked

- Cloned `danny-avila/LibreChat` into `research/LibreChat`.
- Read LibreChat custom endpoint config and server route wiring.
- Inspected the pinned `@librechat/agents@3.1.86` package from npm.
- Inspected the pinned `@langchain/openai@1.4.5` package from npm, because LibreChat delegates OpenAI Responses requests to it.

## Static contract found so far

### Custom OpenAI-compatible endpoint config

LibreChat supports custom OpenAI-compatible endpoints under `endpoints.custom` in `librechat.yaml` style config. The examples show the expected shape:

```yaml
endpoints:
  custom:
    - name: 'MyEndpoint'
      apiKey: '${MY_API_KEY}'
      baseURL: 'http://127.0.0.1:8080/v1'
      models:
        default: ['agent-sandbox']
        fetch: true
```

Important behavior from `packages/api/src/endpoints/custom/initialize.ts`:

- `apiKey` and `baseURL` can come from env vars.
- The endpoint initializes through LibreChat's OpenAI config path.
- `baseURL` becomes the OpenAI client's upstream base URL.
- `headers`, `addParams`, `dropParams`, `customParams`, and `streamRate` can be configured.

### Model discovery

When `models.fetch: true`, LibreChat calls upstream model discovery from `packages/api/src/endpoints/models.ts`.

Confirmed request shape:

- Method: `GET`
- URL: `{baseURL without trailing slash}/models`
- Header: `Authorization: Bearer <apiKey>`
- Timeout: `5000ms`
- Expected response shape: OpenAI-style list with `data[].id`

Minimal wrapper implication:

- Add `GET /v1/models`.
- Return at least:

```json
{
  "object": "list",
  "data": [
    {
      "id": "agent-sandbox",
      "object": "model",
      "created": 0,
      "owned_by": "cloudagent"
    }
  ]
}
```

If we set `models.fetch: false` and provide `models.default`, LibreChat can avoid model discovery, but implementing `/v1/models` is still the cleaner OpenAI-compatible path.

### Generation path with Responses API

LibreChat's app code exposes a `useResponsesApi` parameter. `@librechat/agents@3.1.86` defines `LibreChatOpenAIResponses extends OriginalChatOpenAIResponses` and only overrides reasoning/client options. It does not rewrite the HTTP request shape.

The actual request behavior is therefore from `@langchain/openai@1.4.5`:

- Non-streaming calls `client.responses.create({... stream: false ...})`.
- Streaming calls `client.responses.create({... stream: true ...})`.
- With a base URL of `http://127.0.0.1:8080/v1`, the OpenAI SDK path is expected to be `POST http://127.0.0.1:8080/v1/responses`.

Confirmed request body fields from LangChain's `ChatOpenAIResponses.invocationParams()`:

- `model`
- `input`
- `stream`
- `temperature`
- `top_p`
- `user`
- `service_tier`
- `previous_response_id`
- `truncation`
- `include`
- `tools`
- `tool_choice`
- `text`
- `parallel_tool_calls`
- `max_output_tokens`
- `prompt_cache_key`
- `prompt_cache_retention`
- `reasoning`
- plus model kwargs

The `input` is Responses API style. Basic text input becomes message items with content blocks like:

```json
{
  "type": "message",
  "role": "user",
  "content": [
    {
      "type": "input_text",
      "text": "hello"
    }
  ]
}
```

### Streaming events LibreChat/LangChain can consume

`@langchain/openai@1.4.5` converts these OpenAI Responses stream event types:

- `response.created`
- `response.output_item.added`
- `response.output_text.delta`
- `response.output_text.annotation.added`
- `response.output_item.done`
- `response.function_call_arguments.delta`
- `response.custom_tool_call_input.delta`
- `response.web_search_call.completed`
- `response.file_search_call.completed`
- `response.refusal.done`
- `response.reasoning_summary_part.added`
- `response.reasoning_summary_text.delta`
- `response.completed`

Minimal wrapper implication:

- Existing wrapper stream shape already has the important text path: `response.created`, `response.output_text.delta`, `response.output_text.done`, `response.completed`.
- It should be enough for basic streaming chat.
- Tool-call streaming may require more event compatibility if LibreChat expects function-call chunks in the UI.

### `previous_response_id`

LangChain forwards `previous_response_id` if LibreChat includes it. LibreChat also has server-side Responses code that validates it as a string.

Minimal wrapper implication:

- Current wrapper rejection of `previous_response_id` is a likely blocker for multi-turn Responses API conversations.
- For first compatibility, accept it and map it to wrapper-managed conversation/session state, or at least tolerate it without failing while keeping server-side state by response id.

### Auth headers

LibreChat model discovery and OpenAI client use normal OpenAI-style auth:

- `Authorization: Bearer <apiKey>`

Custom endpoint config can add extra headers, but relying on custom headers for tenant/project identity makes setup less portable.

Minimal wrapper implication:

- Add Bearer compatibility.
- Map the bearer key to default tenant/project values, or allow default tenant/project env vars for OpenAI-compatible clients.
- Keep `X-Tenant-ID` / `X-Project-ID` as explicit override for internal tests.

### Files and attachments

LibreChat front-end upload endpoints are local LibreChat endpoints:

- `POST /api/files`
- `GET /api/files`
- `GET /api/files/:file_id/preview`
- `GET /api/files/download/:userId/:fileId`
- `GET /api/files/download-url/:userId/:fileId`
- `DELETE /api/files`

The UI upload path does not mean the browser directly calls upstream `POST /v1/files`. LibreChat first stores/processes files in its own backend.

Provider upload exists in server code for some flows. For OpenAI-style files, `api/server/services/Files/OpenAI/crud.js` calls `openai.files.create(...)`, which maps to upstream `POST /files` under the configured OpenAI base URL. There are also code paths that build file URLs as `${openai.baseURL}/files/...`.

Minimal wrapper implication:

- Do not assume file upload compatibility is proven by static reading.
- The wrapper probably needs more than current `POST /v1/files` and `GET /v1/files/:id/content` for smooth LibreChat file UX.
- Likely next endpoints to add after dynamic capture:
  - `GET /v1/files`
  - `GET /v1/files/:id`
  - `DELETE /v1/files/:id`
  - keep `GET /v1/files/:id/content`

## LibreChat's own agent API is separate

LibreChat also exposes its own server routes:

- `POST /api/agents/v1/responses`
- `GET /api/agents/v1/responses/models`
- `GET /api/agents/v1/responses/:id`
- `POST /api/agents/v1/chat/completions`
- `GET /api/agents/v1/models`

These are LibreChat's internal/agent-facing APIs, not the generic external OpenAI-compatible upstream path we want for `gateway`.

## Current wrapper gap list, refined

For a clean LibreChat custom endpoint integration, wrapper should next add:

1. `GET /v1/models`.
2. `Authorization: Bearer` compatibility.
3. Tolerant/minimal `previous_response_id` support.
4. More complete `/v1/files` metadata/list/delete endpoints after dynamic capture.
5. A small capture/mock script or LibreChat local run that records actual upstream requests for:
   - startup model discovery,
   - first streaming response,
   - second turn with `previous_response_id`,
   - file upload/attachment path.

## Not yet proven

- Full LibreChat app was not started in this pass.
- No browser/UI request capture has been collected yet.
- Exact file/attachment behavior for custom endpoint + `useResponsesApi: true` still needs dynamic proof.
- The notes above are static-source and pinned-package evidence, not a full runtime trace.
