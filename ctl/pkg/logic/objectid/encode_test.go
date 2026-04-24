package objectid

import (
	"testing"
)

// TestInt2StrStr2Int 验证进制转换的正确性
func TestInt2StrStr2Int(t *testing.T) {
	cases := []struct {
		val  int64
		base int
		len  int
		want string
	}{
		{123456, 36, 8, "00002n9c"},
		{0, 36, 8, "00000000"},
		{1, 36, 8, "00000001"},
		{36, 36, 8, "00000010"},
	}
	for _, c := range cases {
		got := int2str(c.val, c.base, c.len)
		if got != c.want {
			t.Errorf("int2str(%d, %d, %d) = %q, want %q", c.val, c.base, c.len, got, c.want)
		}
		back := str2int(got, c.base)
		if back != c.val {
			t.Errorf("str2int(%q, %d) = %d, want %d", got, c.base, back, c.val)
		}
	}
}

// TestEncodePassword 验证密码编码
func TestEncodePassword(t *testing.T) {
	// Python: encode_password("batch", 41) => 截取低41位
	pw := encodePassword("batch", 41)
	if pw <= 0 {
		t.Errorf("encodePassword(\"batch\", 41) = %d, want > 0", pw)
	}
}

// TestInverse 验证模逆元
func TestInverse(t *testing.T) {
	// inverse(a, prime) * a ≡ 1 (mod prime)
	cases := []int64{1, 5, 100, 12345, 4294967028}
	for _, a := range cases {
		inv := inverse(a, prime)
		// (inv * a) mod prime should be 1
		product := mulMod(inv, a, prime)
		if product != 1 {
			t.Errorf("inverse(%d, %d) = %d, but inverse*a mod prime = %d, want 1", a, prime, inv, product)
		}
	}
}

// mulMod 大数乘法取模（避免溢出）
func mulMod(a, b, m int64) int64 {
	a = a % m
	b = b % m
	var result int64
	for b > 0 {
		if b&1 == 1 {
			result = (result + a) % m
		}
		a = (a * 2) % m
		b >>= 1
	}
	return result
}

// TestEncodeDecode 验证编解码可逆性
func TestEncodeDecode(t *testing.T) {
	password := "passmonlocal_dev"
	region := "ap-beijing"
	regionID := int64(8) // ap-beijing = 8

	for _, autoID := range []int64{1, 5, 100, 12345, 999999, 4294967028} {
		encoded := EncodePassID(autoID, password, region)
		if len(encoded) != idLen {
			t.Errorf("EncodePassID(%d) length = %d, want %d", autoID, len(encoded), idLen)
		}

		decodedID, decodedRegion := DecodePassID(encoded, password)
		if decodedID != autoID {
			t.Errorf("DecodePassID(%q) autoID = %d, want %d", encoded, decodedID, autoID)
		}
		if decodedRegion != regionID {
			t.Errorf("DecodePassID(%q) regionID = %d, want %d", encoded, decodedRegion, regionID)
		}
	}
}

// TestEncodeLightpowerCompatibility 验证与 lightpower 编码完全一致
// 使用 Python 独立验证的参考值
func TestEncodeLightpowerCompatibility(t *testing.T) {
	// Python: encode(5, 32, 1, 9, "batch1", 36, 4294967029, 8) => "0eix78bg"
	result2 := encode(5, 32, 1, 9, "batch1", 36, 4294967029, 8)
	if result2 != "0eix78bg" {
		t.Errorf("encode(5, ..., 'batch1', ...) = %q, want %q", result2, "0eix78bg")
	}

	// Python: EncodePassID(1, "passmonlocal_dev", "ap-beijing") => "jyxpuid0"
	r1 := EncodePassID(1, "passmonlocal_dev", "ap-beijing")
	if r1 != "jyxpuid0" {
		t.Errorf("EncodePassID(1) = %q, want %q", r1, "jyxpuid0")
	}

	// Python: EncodePassID(5, "passmonlocal_dev", "ap-beijing") => "elreyahm"
	r5 := EncodePassID(5, "passmonlocal_dev", "ap-beijing")
	if r5 != "elreyahm" {
		t.Errorf("EncodePassID(5) = %q, want %q", r5, "elreyahm")
	}

	// Python: EncodePassID(100, "passmonlocal_dev", "ap-beijing") => "raq7olio"
	r100 := EncodePassID(100, "passmonlocal_dev", "ap-beijing")
	if r100 != "raq7olio" {
		t.Errorf("EncodePassID(100) = %q, want %q", r100, "raq7olio")
	}

	// 验证可逆
	decodedID, decodedRegion := DecodePassID(r1, "passmonlocal_dev")
	if decodedID != 1 {
		t.Errorf("DecodePassID(%q) autoID = %d, want 1", r1, decodedID)
	}
	if decodedRegion != 8 { // ap-beijing = 8
		t.Errorf("DecodePassID(%q) region = %d, want 8", r1, decodedRegion)
	}
}

// TestEncodePassIDUniqueness 验证不同 autoID 生成不同的编码
func TestEncodePassIDUniqueness(t *testing.T) {
	password := "passmonlocal_dev"
	region := "ap-beijing"
	seen := make(map[string]int64)

	for i := int64(1); i <= 10000; i++ {
		encoded := EncodePassID(i, password, region)
		if prev, ok := seen[encoded]; ok {
			t.Fatalf("collision: autoID %d and %d both encode to %q", prev, i, encoded)
		}
		seen[encoded] = i
	}
}
