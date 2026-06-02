package wrapper

// ExternalLockStores holds optional external implementations for the
// distributed lock interfaces. When provided, these override the default
// SQLite-based implementations.
type ExternalLockStores struct {
	RuntimeOwnership RuntimeOwnershipStore
	RuntimeLock      RuntimeEnsureLocker
	WorkspaceService WorkspaceService
}

// SetExternalLockStores replaces the ACPGateway's lock/lease implementations
// with external ones (e.g., Redis). This allows the gateway to use distributed
// locks without changing the primary Store (SQLite or MySQL) for data persistence.
//
// Call this after NewServer but before serving traffic.
func (s *Server) SetExternalLockStores(ext ExternalLockStores) {
	if ext.RuntimeOwnership != nil {
		s.acpGate.runtimeOwnership = ext.RuntimeOwnership
	}
	if ext.RuntimeLock != nil {
		s.acpGate.runtimeLock = ext.RuntimeLock
	}
	if ext.WorkspaceService != nil {
		s.acpGate.workspaceService = ext.WorkspaceService
	}
}
