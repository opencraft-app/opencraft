package eventoutbox

import (
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestNewRelayDoesNotConnectToPulsarOnCoreServiceStartup(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	relay, err := NewRelay(sqlDB, RelayConfig{
		URL: "pulsar://unreachable.invalid:6650", Token: "configured-token", Topic: "persistent://tenant/ns/topic",
	})
	if err != nil {
		t.Fatalf("NewRelay must not make broker availability a startup dependency: %v", err)
	}
	relay.Close()
}
