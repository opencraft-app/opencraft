package modelgateway

import "testing"

func TestNormalizeChatCompletionsEndpoint(t *testing.T) {
	tests := map[string]string{
		"https://models.example":                     "https://models.example/v1/chat/completions",
		"https://models.example/v1":                  "https://models.example/v1/chat/completions",
		"https://models.example/openai":              "https://models.example/openai/v1/chat/completions",
		"https://models.example/v1/chat/completions": "https://models.example/v1/chat/completions",
	}
	for input, want := range tests {
		got, err := NormalizeChatCompletionsEndpoint(input)
		if err != nil || got != want {
			t.Fatalf("NormalizeChatCompletionsEndpoint(%q)=%q,%v want %q", input, got, err, want)
		}
	}
}

func TestRegistryCredentialsAreIsolatedByUser(t *testing.T) {
	registry := NewRegistry()
	if _, err := registry.Register("one", "https://one.example/v1"); err != nil {
		t.Fatal(err)
	}
	if err := registry.SetUserCredential("alice", "one", "secret-a", "model-a", "Provider A"); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := registry.UserCredential("bob"); ok {
		t.Fatal("bob unexpectedly inherited alice's credential")
	}
	provider, key, ok := registry.UserCredential("alice")
	if !ok || provider != "one" || key != "secret-a" {
		t.Fatalf("credential=%q,%q,%v", provider, key, ok)
	}
	registry.ClearUserCredential("alice")
	if _, _, ok := registry.UserCredential("alice"); ok {
		t.Fatal("credential survived clear")
	}
}

func TestRegistryKeepsMultipleVolatileProfilesAndSwitchesActive(t *testing.T) {
	registry := NewRegistry()
	for _, id := range []string{"one", "two"} {
		if _, err := registry.Register(id, "https://"+id+".example/v1"); err != nil {
			t.Fatal(err)
		}
	}
	if err := registry.SetUserCredential("alice", "one", "secret-one", "model-one", "One"); err != nil {
		t.Fatal(err)
	}
	if err := registry.SetUserCredential("alice", "two", "secret-two", "model-two", "Two"); err != nil {
		t.Fatal(err)
	}
	if !registry.UserCredentialLoaded("alice", "one") || !registry.UserCredentialLoaded("alice", "two") {
		t.Fatal("both in-memory profiles should remain loaded")
	}
	if err := registry.ActivateUserCredential("alice", "one"); err != nil {
		t.Fatal(err)
	}
	provider, key, ok := registry.UserCredential("alice")
	if !ok || provider != "one" || key != "secret-one" {
		t.Fatalf("active credential=%q,%q,%v", provider, key, ok)
	}
	registry.DeactivateUserCredential("alice")
	if _, _, ok := registry.UserCredential("alice"); ok {
		t.Fatal("subscription mode must not expose an active API credential")
	}
	if !registry.UserCredentialLoaded("alice", "two") {
		t.Fatal("deactivating a profile should not erase its volatile key")
	}
	registry.RemoveUserCredential("alice", "two")
	if registry.UserCredentialLoaded("alice", "two") {
		t.Fatal("removed profile key remained loaded")
	}
}
