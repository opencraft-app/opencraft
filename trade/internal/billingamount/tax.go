package billingamount

import (
	"fmt"
	"math/big"
	"strings"
)

const amountToCentsDivisor = int64(1_000_000)

// TaxInclusiveCents applies a decimal tax rate to a non-negative main-currency
// * 1e8 amount and rounds any positive fractional cent up to the next whole cent.
func TaxInclusiveCents(rawAmount, rawTaxRate string) (string, error) {
	amountText := strings.TrimSpace(rawAmount)
	amount, ok := new(big.Rat).SetString(amountText)
	if !ok || amount.Sign() < 0 {
		return "", fmt.Errorf("amount must be a non-negative decimal: %q", amountText)
	}
	taxRateText := strings.TrimSpace(rawTaxRate)
	taxRate, ok := new(big.Rat).SetString(taxRateText)
	if !ok {
		return "", fmt.Errorf("tax rate must be a decimal: %q", taxRateText)
	}
	if taxRate.Sign() < 0 {
		return "", fmt.Errorf("tax rate must be non-negative: %q", taxRateText)
	}

	taxMultiplier := new(big.Rat).Add(big.NewRat(1, 1), taxRate)
	taxInclusiveAmount := new(big.Rat).Mul(amount, taxMultiplier)
	centsDivisor := new(big.Int).Mul(
		new(big.Int).Set(taxInclusiveAmount.Denom()),
		big.NewInt(amountToCentsDivisor),
	)
	cents := new(big.Int)
	remainder := new(big.Int)
	cents.QuoRem(new(big.Int).Set(taxInclusiveAmount.Num()), centsDivisor, remainder)
	if remainder.Sign() > 0 {
		cents.Add(cents, big.NewInt(1))
	}
	return cents.String(), nil
}
