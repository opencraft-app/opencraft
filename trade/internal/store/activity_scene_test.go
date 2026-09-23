package store

import "testing"

func TestActivitySceneValidation(t *testing.T) {
	for _, scene := range []ActivityScene{ActivityScenePurchase, ActivitySceneRenew} {
		if !scene.Valid() {
			t.Errorf("scene %q should be valid", scene)
		}
	}
	if ActivityScene("refund").Valid() {
		t.Fatal("unexpected refund scene support")
	}
}
