# vela-protocol

`vela-protocol` contains external wire DTO helpers aligned with the OpenAPI contract.

This crate is deliberately thin. It may shape REST/SSE payloads, but business rules stay in `vela-runtime`, storage rules stay in `vela-store`, and projection logic stays in `vela-projection`.
