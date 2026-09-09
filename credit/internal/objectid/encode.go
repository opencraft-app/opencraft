// Package objectid generates opaque Credit resource IDs.
package objectid

import (
	"fmt"
	"strings"
)

const (
	creditPackageIDLength = 8
	prefixBitLength       = 32
	regionBitLength       = 9
	encodingPrime         = int64(4294967029)
	encodingBase          = 36
)

// Keep this map aligned with ctl/pkg/logic/objectid so Credit IDs carry the
// same region semantics as Pass IDs.
var regionIDs = map[string]int64{
	"ap-guangzhou":      1,
	"ap-shanghai":       4,
	"ap-hongkong":       5,
	"na-toronto":        6,
	"ap-shanghai-fsi":   7,
	"ap-beijing":        8,
	"ap-singapore":      9,
	"ap-shenzhen-fsi":   11,
	"ap-guangzhou-open": 12,
	"na-siliconvalley":  15,
	"ap-chengdu":        16,
	"eu-frankfurt":      17,
	"ap-seoul":          18,
	"ap-chongqing":      19,
	"ap-mumbai":         21,
	"na-ashburn":        22,
	"ap-bangkok":        23,
	"eu-moscow":         24,
	"ap-tokyo":          25,
	"ap-jinan-ec":       31,
	"ap-hangzhou-ec":    32,
	"ap-nanjing":        33,
	"ap-fuzhou-ec":      34,
	"ap-wuhan-ec":       35,
	"ap-tianjin":        36,
	"ap-shenzhen":       37,
	"ap-taipei":         39,
	"ap-changsha-ec":    45,
	"ap-beijing-fsi":    46,
	"ap-jakarta":        72,
}

// GenerateCreditPackageID encodes a database sequence and region into the
// same eight-character base36 representation used by Pass IDs.
func GenerateCreditPackageID(autoID int64, password, region string) (string, error) {
	if autoID <= 0 {
		return "", fmt.Errorf("invalid autoID: %d", autoID)
	}
	password = strings.TrimSpace(password)
	if password == "" {
		return "", fmt.Errorf("password is required")
	}
	regionID, ok := regionIDs[strings.TrimSpace(region)]
	if !ok {
		return "", fmt.Errorf("unsupported region %q", region)
	}
	encoded := encode(autoID, prefixBitLength, regionID, regionBitLength, password, encodingBase, encodingPrime, creditPackageIDLength)
	return "cpkg-" + encoded, nil
}

func encode(prefix int64, prefLen int, postfix int64, postLen int, password string, base int, prime int64, retLen int) string {
	passwordValue := encodePassword(password, prefLen+postLen)
	inverted := inverse(prefix, prime)
	shuffled := shufflePrefixPostfix(inverted, prefLen, postfix, postLen)
	return intToString(shuffled^passwordValue, base, retLen)
}

func intToString(value int64, base, length int) string {
	if value < 0 {
		modulus := int64(1)
		for range length {
			modulus *= int64(base)
		}
		value = ((value % modulus) + modulus) % modulus
	}
	buf := make([]byte, 0, length)
	for unsigned, radix := uint64(value), uint64(base); unsigned > 0; unsigned /= radix {
		digit := unsigned % radix
		if digit <= 9 {
			buf = append(buf, byte('0'+digit))
		} else {
			buf = append(buf, byte('a'+digit-10))
		}
	}
	for i, j := 0, len(buf)-1; i < j; i, j = i+1, j-1 {
		buf[i], buf[j] = buf[j], buf[i]
	}
	for len(buf) < length {
		buf = append([]byte{'0'}, buf...)
	}
	return string(buf)
}

func encodePassword(value string, length int) int64 {
	var encoded int64
	for i := len(value) - 1; i >= 0; i-- {
		encoded |= int64(value[i]) << (8 * (len(value) - 1 - i))
	}
	if length > 0 && length < 64 {
		encoded &= (1 << length) - 1
	}
	return encoded
}

func inverse(a, b int64) int64 {
	_, x, _ := extendedEuclid(a, b)
	if x < 0 {
		x = ((x % b) + b) % b
	}
	return x
}

func extendedEuclid(a, b int64) (divisor, x, y int64) {
	if b <= 0 {
		return a, 1, 0
	}
	divisor, x1, y1 := extendedEuclid(b, a%b)
	return divisor, y1, x1 - (a/b)*y1
}

func shufflePrefixPostfix(prefix int64, prefLen int, postfix int64, postLen int) int64 {
	var result int64
	step := prefLen / postLen
	for i := 0; i < postLen; i++ {
		prefixLength := step
		if i == postLen-1 {
			prefixLength = prefLen - i*step
		}
		prefixBits := splitBits(prefix, i*step, prefixLength)
		postfixBit := splitBits(postfix, i, 1)
		result |= ((prefixBits << 1) | postfixBit) << ((step + 1) * i)
	}
	return result
}

func splitBits(value int64, position, length int) int64 {
	return (value >> position) & ((1 << length) - 1)
}
