# OpenCraft execution terminology

Terms used to describe Codex execution and recovery in OpenCraft.

## Language

**Codex AppServer instance**: One running Codex server that owns its conversations and execution environment connections. Several conversations can belong to the same instance.

**Codex executor**: Codex's executor for commands and filesystem operations. It is distinct from the connection between OpenCraft and the AppServer.
_Avoid_: OpenCraft connection component

**Execution environment**: The execution destination selected for a conversation's commands and filesystem operations. Several conversations can share one execution environment.

**Execution availability**: Whether the selected execution environment can currently serve execution requests. An accessible conversation history does not establish execution availability.
_Avoid_: Connection health as a synonym for execution availability

**Delivery unknown**: An accepted input or command whose delivery or result cannot currently be established. It is neither confirmed failure nor permission to repeat the operation.
