// Package objectid — 编码算法
//
// 移植自 lightpower/utils/encode_id_util.py
// 编码流程：auto_id → modular inverse → bit interleave (region) → XOR password → base-36 string
// 解码流程完全可逆。
package objectid

// ---------- 常量 ----------

// 8 位编码对应的参数（与 lightpower POST_PRE_LEN_MAP / PRIME_MAP 一致）
const (
	idLen      = 8
	prefixLen  = 32 // 主 ID bit 宽度
	postfixLen = 9  // 地域信息 bit 宽度
	prime      = 4294967029
	idBase     = 36
)

// regionIDMap 与 lightpower uniform_conf.py 中 REGION_ID_MAP 保持一致
var regionIDMap = map[string]int64{
	"ap-guangzhou":     1,
	"ap-shanghai":      4,
	"ap-hongkong":      5,
	"na-toronto":       6,
	"ap-shanghai-fsi":  7,
	"ap-beijing":       8,
	"ap-singapore":     9,
	"ap-shenzhen-fsi":  11,
	"ap-guangzhou-open": 12,
	"na-siliconvalley": 15,
	"ap-chengdu":       16,
	"eu-frankfurt":     17,
	"ap-seoul":         18,
	"ap-chongqing":     19,
	"ap-mumbai":        21,
	"na-ashburn":       22,
	"ap-bangkok":       23,
	"eu-moscow":        24,
	"ap-tokyo":         25,
	"ap-jinan-ec":      31,
	"ap-hangzhou-ec":   32,
	"ap-nanjing":       33,
	"ap-fuzhou-ec":     34,
	"ap-wuhan-ec":      35,
	"ap-tianjin":       36,
	"ap-shenzhen":      37,
	"ap-taipei":        39,
	"ap-changsha-ec":   45,
	"ap-beijing-fsi":   46,
	"ap-jakarta":       72,
}

// ---------- 对外 API ----------

// EncodePassID 将自增 ID 编码为 8 字符 base-36 字符串
// password: 加密密钥（与 lightpower OBJECT_PASSWORD_MAP 对应），如 "passmon" + suffix
// region:   地域名，如 "ap-beijing"
func EncodePassID(autoID int64, password string, region string) string {
	regionID := int64(0)
	if v, ok := regionIDMap[region]; ok {
		regionID = v
	}
	return encode(autoID, prefixLen, regionID, postfixLen, password, idBase, prime, idLen)
}

// DecodePassID 从 8 字符 base-36 字符串解码出 (自增ID, 地域ID)
func DecodePassID(encoded string, password string) (autoID int64, regionID int64) {
	return decode(encoded, prefixLen, postfixLen, password, idBase, prime)
}

// ---------- 核心编解码 ----------

func encode(prefix int64, prefLen int, postfix int64, postLen int, password string, base int, prm int64, retLen int) string {
	pw := encodePassword(password, prefLen+postLen)
	inv := inverse(prefix, prm)
	shuffled := shufflePrefixPostfix(inv, prefLen, postfix, postLen)
	shuffled ^= pw
	return int2str(shuffled, base, retLen)
}

func decode(v string, prefLen int, postLen int, password string, base int, prm int64) (int64, int64) {
	pw := encodePassword(password, prefLen+postLen)
	val := str2int(v, base)
	val ^= pw
	prefix, postfix := splitPrefixPostfix(val, prefLen, postLen)
	return inverse(prefix, prm), postfix
}

// ---------- 工具函数 ----------

// int2str 将整数转为 base 进制字符串，左填充 '0' 到 retLen 位
func int2str(v int64, base int, retLen int) string {
	if v < 0 {
		// 处理负数：取模到正数域
		// 对于 8 位 base-36 编码，最大值为 36^8 - 1 = 2_821_109_907_455
		modulus := int64(1)
		for i := 0; i < retLen; i++ {
			modulus *= int64(base)
		}
		v = ((v % modulus) + modulus) % modulus
	}

	buf := make([]byte, 0, retLen)
	uv := uint64(v)
	ub := uint64(base)
	for uv > 0 {
		m := uv % ub
		uv = uv / ub
		if m <= 9 {
			buf = append(buf, byte('0'+m))
		} else {
			buf = append(buf, byte('a'+m-10))
		}
	}
	// reverse
	for i, j := 0, len(buf)-1; i < j; i, j = i+1, j-1 {
		buf[i], buf[j] = buf[j], buf[i]
	}
	// left pad
	for len(buf) < retLen {
		buf = append([]byte{'0'}, buf...)
	}
	return string(buf)
}

// str2int 将 base 进制字符串转为整数
func str2int(v string, base int) int64 {
	var ret int64
	for i := len(v) - 1; i >= 0; i-- {
		c := v[len(v)-1-i]
		var iv int64
		if c >= '0' && c <= '9' {
			iv = int64(c - '0')
		} else {
			iv = 10 + int64(c-'a')
		}
		p := int64(1)
		for j := 0; j < i; j++ {
			p *= int64(base)
		}
		ret += p * iv
	}
	return ret
}

// encodePassword 将密码字符串转为整数，截取低 retLen 位
func encodePassword(v string, retLen int) int64 {
	var ret int64
	for i := len(v) - 1; i >= 0; i-- {
		c := v[i]
		ret |= int64(c) << (8 * (len(v) - 1 - i))
	}
	if retLen > 0 && retLen < 64 {
		ret &= (1 << retLen) - 1
	}
	return ret
}

// extendedEuclid 扩展欧几里得算法
// d = a*x + b*y
func extendedEuclid(a, b int64) (d, x, y int64) {
	if b <= 0 {
		return a, 1, 0
	}
	d, x1, y1 := extendedEuclid(b, a%b)
	return d, y1, x1 - (a/b)*y1
}

// inverse 模逆元：求 a 在模 b 下的逆元
func inverse(a, b int64) int64 {
	_, x, _ := extendedEuclid(a, b)
	if x < 0 {
		x = ((x % b) + b) % b
	}
	return x
}

// splitBit 从 val 的 pos 位置取 length 个 bit
func splitBit(val int64, pos, length int) int64 {
	return (val >> pos) & ((1 << length) - 1)
}

// stepLen 计算平均步长
func stepLen(prefLen, postLen int) int {
	return prefLen / postLen
}

// stepPostfixLen 计算每步实际 prefix bit 长度
func stepPostfixLen(stepIdx, step, prefLen, postLen int) int {
	if stepIdx == postLen-1 {
		return prefLen - stepIdx*step
	}
	return step
}

// shufflePrefixPostfix 将 postfix 打散到 prefix 中
func shufflePrefixPostfix(prefix int64, prefLen int, postfix int64, postLen int) int64 {
	var result int64
	step := stepLen(prefLen, postLen)
	for i := 0; i < postLen; i++ {
		spLen := stepPostfixLen(i, step, prefLen, postLen)
		prefBits := splitBit(prefix, i*step, spLen)
		postBit := splitBit(postfix, i, 1)
		combined := (prefBits << 1) | postBit
		result |= combined << ((step + 1) * i)
	}
	return result
}

// splitPrefixPostfix 从混合值中分离出 prefix 和 postfix
func splitPrefixPostfix(val int64, prefLen, postLen int) (int64, int64) {
	var prefix, postfix int64
	step := stepLen(prefLen, postLen)
	for i := 0; i < postLen; i++ {
		spLen := stepPostfixLen(i, step, prefLen, postLen)
		postfix |= splitBit(val, (step+1)*i, 1) << i
		prefix |= splitBit(val, (step+1)*i+1, spLen) << (step * i)
	}
	return prefix, postfix
}
