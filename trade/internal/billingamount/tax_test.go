package billingamount

import (
	"strings"
	"testing"
)

func TestTaxInclusiveCents(t *testing.T) {
	tests := []struct {
		name      string
		amount    string
		taxRate   string
		wantCents string
	}{
		{name: "fractional cent rounds up", amount: "650000000", taxRate: "0.07", wantCents: "696"},
		{name: "exact cents", amount: "650000000", taxRate: "0.10", wantCents: "715"},
		{name: "sub-cent amount rounds up after tax", amount: "650000001", taxRate: "0.07", wantCents: "696"},
		{name: "decimal raw amount", amount: "750000000.0", taxRate: "0.07", wantCents: "803"},
		{name: "positive amount below one cent rounds up", amount: "1", taxRate: "0", wantCents: "1"},
		{name: "zero amount remains zero", amount: "0", taxRate: "0.09", wantCents: "0"},
		{name: "zero tax", amount: "650000000", taxRate: "0", wantCents: "650"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := TaxInclusiveCents(tt.amount, tt.taxRate)
			if err != nil {
				t.Fatalf("TaxInclusiveCents(%q, %q): %v", tt.amount, tt.taxRate, err)
			}
			if got != tt.wantCents {
				t.Fatalf("cents = %q, want %q", got, tt.wantCents)
			}
		})
	}
}

func TestTaxInclusiveCentsRejectsInvalidInput(t *testing.T) {
	tests := []struct {
		name    string
		amount  string
		taxRate string
		field   string
	}{
		{name: "missing amount", taxRate: "0.07", field: "amount"},
		{name: "malformed amount", amount: "bad", taxRate: "0.07", field: "amount"},
		{name: "negative amount", amount: "-1", taxRate: "0.07", field: "amount"},
		{name: "missing tax", amount: "650000000", field: "tax rate"},
		{name: "malformed tax", amount: "650000000", taxRate: "bad", field: "tax rate"},
		{name: "negative tax", amount: "650000000", taxRate: "-0.01", field: "tax rate"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := TaxInclusiveCents(tt.amount, tt.taxRate)
			if err == nil || !strings.Contains(err.Error(), tt.field) {
				t.Fatalf("TaxInclusiveCents(%q, %q) error = %v, want %q error", tt.amount, tt.taxRate, err, tt.field)
			}
		})
	}
}
