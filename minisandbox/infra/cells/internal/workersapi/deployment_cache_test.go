package workersapi

import "testing"

func cachedWorker(name, cursor, version string) registryWorker {
	return registryWorker{
		Name: name, DeploymentCursor: cursor,
		Deployment: registryDeployment{
			ID: "d_11111111111111111111111111111111", Worker: name,
			Versions: []DeploymentVersion{{VersionID: version, Percentage: 100}},
		},
		Versions: []registryVersion{{VersionID: version}},
	}
}

func TestDeploymentCacheRequiresWatchSyncAndBoundsEntries(t *testing.T) {
	cache := newDeploymentCache(2)
	if cache.PutIfCurrent("one", cachedWorker("one", initialDeploymentCursor, testVersionOne), 0, initialDeploymentCursor) {
		t.Fatal("unsynchronized cache accepted an entry")
	}
	if !cache.ObserveCursor(initialDeploymentCursor) {
		t.Fatal("valid initial cursor was rejected")
	}
	generation, cursor, synced := cache.Fence()
	if !synced || !cache.PutIfCurrent("one", cachedWorker("one", cursor, testVersionOne), generation, cursor) ||
		!cache.PutIfCurrent("two", cachedWorker("two", cursor, testVersionOne), generation, cursor) ||
		!cache.PutIfCurrent("three", cachedWorker("three", cursor, testVersionOne), generation, cursor) {
		t.Fatal("synchronized cache rejected an entry")
	}
	if cache.Len() != 2 {
		t.Fatalf("cache length = %d, want 2", cache.Len())
	}
	if _, ok := cache.Get("one"); ok {
		t.Fatal("least-recent entry was not evicted")
	}
}

func TestDeploymentCacheCursorFencesRacingRegistryRead(t *testing.T) {
	cache := newDeploymentCache(2)
	oldCursor := "c_11111111111111111111111111111111"
	newCursor := "c_22222222222222222222222222222222"
	cache.ObserveCursor(oldCursor)
	generation, cursor, _ := cache.Fence()
	cache.ObserveCursor(newCursor)
	if cache.PutIfCurrent("counter", cachedWorker("counter", oldCursor, testVersionOne), generation, cursor) {
		t.Fatal("response from before invalidation repopulated cache")
	}
	if cache.Len() != 0 {
		t.Fatal("cursor change did not clear cache")
	}
}

func TestDeploymentCacheDisconnectFailsClosed(t *testing.T) {
	cache := newDeploymentCache(2)
	cursor := "c_11111111111111111111111111111111"
	cache.ObserveCursor(cursor)
	generation, _, _ := cache.Fence()
	cache.PutIfCurrent("counter", cachedWorker("counter", cursor, testVersionOne), generation, cursor)
	cache.Invalidate()
	if _, ok := cache.Get("counter"); ok || cache.Len() != 0 {
		t.Fatal("disconnected cache served an entry")
	}
	if cache.PutIfCurrent("counter", cachedWorker("counter", cursor, testVersionOne), generation, cursor) {
		t.Fatal("disconnected cache accepted a late response")
	}
}
