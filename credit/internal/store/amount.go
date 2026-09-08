package store

import (
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"math/big"
	"strconv"
	"strings"
)

const creditScale int64 = 10000

// CreditAmount stores credit in ten-thousandths while encoding as a JSON number.
type CreditAmount int64

func CreditAmountFromTokens(tokens, tokensPerCredit int64) (CreditAmount, error) {
	if tokens < 0 {
		return 0, fmt.Errorf("token amount must not be negative")
	}
	if tokensPerCredit <= 0 {
		return 0, fmt.Errorf("tokens per credit must be positive")
	}
	value := new(big.Int).Mul(big.NewInt(tokens), big.NewInt(creditScale))
	value.Quo(value, big.NewInt(tokensPerCredit))
	if !value.IsInt64() {
		return 0, fmt.Errorf("credit amount overflows int64")
	}
	return CreditAmount(value.Int64()), nil
}

func (a CreditAmount) String() string {
	value := int64(a)
	sign := ""
	if value < 0 {
		sign = "-"
		value = -value
	}
	return fmt.Sprintf("%s%d.%04d", sign, value/creditScale, value%creditScale)
}

func (a CreditAmount) MarshalJSON() ([]byte, error) {
	return []byte(a.String()), nil
}

func (a *CreditAmount) UnmarshalJSON(data []byte) error {
	if a == nil {
		return fmt.Errorf("nil CreditAmount")
	}
	var text string
	if len(data) > 0 && data[0] == '"' {
		if err := json.Unmarshal(data, &text); err != nil {
			return err
		}
	} else {
		text = string(data)
	}
	value, err := parseCreditAmount(text)
	if err != nil {
		return err
	}
	*a = value
	return nil
}

func (a *CreditAmount) Scan(src any) error {
	if a == nil {
		return fmt.Errorf("nil CreditAmount")
	}
	var text string
	switch value := src.(type) {
	case []byte:
		text = string(value)
	case string:
		text = value
	case int64:
		text = strconv.FormatInt(value, 10)
	default:
		return fmt.Errorf("unsupported CreditAmount source %T", src)
	}
	parsed, err := parseCreditAmount(text)
	if err != nil {
		return err
	}
	*a = parsed
	return nil
}

func (a CreditAmount) Value() (driver.Value, error) {
	return a.String(), nil
}

func parseCreditAmount(text string) (CreditAmount, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return 0, fmt.Errorf("credit amount is empty")
	}
	rat, ok := new(big.Rat).SetString(text)
	if !ok {
		return 0, fmt.Errorf("invalid credit amount %q", text)
	}
	scaled := new(big.Rat).Mul(rat, big.NewRat(creditScale, 1))
	if !scaled.IsInt() || !scaled.Num().IsInt64() {
		return 0, fmt.Errorf("credit amount %q exceeds four decimal places or int64", text)
	}
	return CreditAmount(scaled.Num().Int64()), nil
}
