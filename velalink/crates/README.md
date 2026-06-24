# Rust Engine Workspace

This folder contains the layered Rust engine. Crates here are organized by architecture boundary, not by file count.

The current engine-only scope includes domain types, storage, backend adapters, runtime command handling, projections, and protocol DTOs. The HTTP daemon (`velad`) is intentionally not implemented yet because the API server is only a thin shell over these layers.
