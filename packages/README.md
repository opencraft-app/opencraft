# packages

Frontend packages live here.

Each package owns one layer of the Chat Surface pipeline. Keep dependencies one-way:

`vela-chat-client -> vela-chat-surface -> vela-chat-render-model -> vela-chat-web -> app/chat`.

Do not hide transport, projection, render policy, and React UI in one component.
