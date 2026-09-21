package policy

import (
	"testing"
	"time"
)

func TestWakeBroadcasterWakesEverySubscriberAndCoalesces(t *testing.T) {
	broadcaster := newWakeBroadcaster()
	first, cancelFirst := broadcaster.subscribe()
	defer cancelFirst()
	second, cancelSecond := broadcaster.subscribe()
	defer cancelSecond()

	broadcaster.notify()
	broadcaster.notify()
	for index, subscriber := range []<-chan struct{}{first, second} {
		select {
		case <-subscriber:
		case <-time.After(time.Second):
			t.Fatalf("subscriber %d was not woken", index)
		}
		select {
		case <-subscriber:
			t.Fatalf("subscriber %d received an uncoalesced duplicate wake", index)
		default:
		}
	}
}
