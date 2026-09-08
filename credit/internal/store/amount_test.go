package store

import (
	"encoding/json"
	"testing"
)

func TestCreditAmountKeepsFourDecimalPlaces(t *testing.T) {
	amount, err := CreditAmountFromTokens(12345, 10000)
	if err != nil {
		t.Fatalf("CreditAmountFromTokens: %v", err)
	}
	if amount.String() != "1.2345" {
		t.Fatalf("amount=%s", amount.String())
	}
	encoded, err := json.Marshal(amount)
	if err != nil {
		t.Fatalf("MarshalJSON: %v", err)
	}
	if string(encoded) != "1.2345" {
		t.Fatalf("json=%s", encoded)
	}
}
