// Package ext4sdk provides an experimental CGO wrapper around lwext4.
//
// This package is intentionally split into:
//   - a default stub build, which keeps normal JuiceFS builds unaffected
//   - an experimental linux+cgo+lwext4sdk implementation
//
// The real implementation expects lwext4 sources to be available at:
//   third_party/lwext4
//
// It is designed around a Go BlockBackend so JuiceFS can later plug in a
// virtual block device backed by a large file or another sparse backend.
package ext4sdk

