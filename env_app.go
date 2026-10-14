package borgo

import (
	"fmt"
	"math"
	"math/big"
	"net"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode"
)

// EnvVar is one server variable of the app's env.ts, as the generated env
// package hands it to ReadEnv. Not written by hand: `borgo build` and
// `borgo dev` write env/env.gen.go from env.ts, so the two halves of the app
// read one contract.
type EnvVar struct {
	Name string
	// "string", "number", "boolean", "url" or "port", as in env.ts
	Type     string
	Optional bool
	// the default, typed as Type reads it: string, float64, bool or int;
	// nil when env.ts declares none
	Default any
	// a validate spec: its validator is javascript, run by the render
	// service at boot, so the go side receives the raw string
	Validated bool
}

// ReadEnv reads the variables with env.ts's rules and in its words: the
// empty string is missing, a default fills a missing value, an optional one
// stays nil, and every refusal is collected and named, as the render
// service's boot check names them. Values come back typed: string, float64,
// bool or int.
func ReadEnv(vars []EnvVar) (map[string]any, error) {
	values := make(map[string]any, len(vars))
	var failures []string
	for _, v := range vars {
		raw := os.Getenv(v.Name)
		if raw == "" {
			switch {
			case v.Default != nil:
				values[v.Name] = v.Default
			case v.Optional:
				values[v.Name] = nil
			default:
				failures = append(failures, fmt.Sprintf("%s: missing (expected %s)", v.Name, describeEnvVar(v)))
			}
			continue
		}
		if v.Validated {
			values[v.Name] = raw
			continue
		}
		value, err := parseEnvValue(v, raw)
		if err != "" {
			failures = append(failures, err)
			continue
		}
		values[v.Name] = value
	}
	if len(failures) > 0 {
		plural := "s"
		if len(failures) == 1 {
			plural = ""
		}
		return nil, fmt.Errorf("borgo env: %d variable%s refused:\n  - %s", len(failures), plural, strings.Join(failures, "\n  - "))
	}
	return values, nil
}

func describeEnvVar(v EnvVar) string {
	if v.Validated {
		return "a value its validator accepts"
	}
	t := v.Type
	if t == "" {
		t = "string"
	}
	return "a " + t
}

// strconv.ParseBool's spellings, the grammar env.ts reads booleans with
var envBools = map[string]bool{
	"1": true, "t": true, "T": true, "TRUE": true, "true": true, "True": true,
	"0": false, "f": false, "F": false, "FALSE": false, "false": false, "False": false,
}

func parseEnvValue(v EnvVar, raw string) (any, string) {
	switch v.Type {
	case "", "string":
		return raw, ""
	case "number":
		n, ok := jsNumber(raw)
		if !ok || math.IsInf(n, 0) || math.IsNaN(n) {
			return nil, fmt.Sprintf("%s: expected a number, got %s", v.Name, jsQuote(raw))
		}
		return n, ""
	case "boolean":
		b, ok := envBools[raw]
		if !ok {
			return nil, fmt.Sprintf("%s: expected a boolean (1/0, true/false, t/f), got %s", v.Name, jsQuote(raw))
		}
		return b, ""
	case "port":
		digits := jsTrim(raw)
		n, err := strconv.Atoi(digits)
		if !allDigits(digits) || err != nil || n > 65535 {
			return nil, fmt.Sprintf("%s: expected a port (an integer 0-65535), got %s", v.Name, jsQuote(raw))
		}
		return n, ""
	case "url":
		if !absoluteURL(raw) {
			return nil, fmt.Sprintf("%s: expected an absolute url, got %s", v.Name, jsQuote(raw))
		}
		return raw, ""
	}
	return nil, fmt.Sprintf("%s: env.ts declares a type the go side does not know (%s)", v.Name, v.Type)
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

var jsDecimal = regexp.MustCompile(`^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$`)

// jsNumber is javascript's Number(raw) for the strings it reads as numbers:
// trimmed, a decimal with an optional exponent, or an unsigned 0x, 0o or 0b
// integer. "Infinity" is not one of those, and the infinity 1e400 reads as
// is refused by the caller.
func jsNumber(raw string) (float64, bool) {
	s := jsTrim(raw)
	if len(s) > 2 && s[0] == '0' {
		base := 0
		switch s[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			// digits of the base and nothing else: SetString would take a sign
			// after the prefix, 0x-1, which Number refuses (found by the verifier
			// of phase 6)
			for i := 2; i < len(s); i++ {
				if !strings.ContainsRune("0123456789abcdefABCDEF"[:digitsFor(base)], rune(s[i])) {
					return 0, false
				}
			}
			n, ok := new(big.Int).SetString(s[2:], base)
			if !ok {
				return 0, false
			}
			f, _ := new(big.Float).SetInt(n).Float64()
			return f, true
		}
	}
	if !jsDecimal.MatchString(s) {
		return 0, false
	}
	// the pattern leaves ParseFloat only an overflow to report, and it comes
	// with the infinity javascript reads too, which the caller refuses
	f, _ := strconv.ParseFloat(s, 64)
	return f, true
}

var urlScheme = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.-]*:`)

// absoluteURL is the check `new URL(raw)` makes, written after the WHATWG
// algorithm for the parts that can refuse a url: the scheme, and for an
// authority its host and port. A path, a query or a fragment never refuses.
// Where it cannot follow the javascript parser it is the stricter of the two
// - a host outside ascii is refused, where the browser would map it - so the
// go side never takes a value the render service refuses (found by the
// verifier of phase 6, after url.Parse disagreed in both directions).
func absoluteURL(raw string) bool {
	s := strings.TrimFunc(raw, func(r rune) bool { return r <= ' ' })
	s = strings.NewReplacer("\t", "", "\n", "", "\r", "").Replace(s)
	if !urlScheme.MatchString(s) {
		return false
	}
	scheme, rest, _ := strings.Cut(s, ":")
	switch strings.ToLower(scheme) {
	case "http", "https", "ws", "wss", "ftp":
		host, port := splitAuthority(strings.TrimLeft(rest, `/\`), true)
		return validPort(port) && validDomain(host)
	case "file":
		// two slashes, either way round, open an authority
		if len(rest) < 2 || !strings.ContainsRune(`/\`, rune(rest[0])) || !strings.ContainsRune(`/\`, rune(rest[1])) {
			return true
		}
		end := strings.IndexAny(rest[2:], `/\?#`)
		host := rest[2:]
		if end >= 0 {
			host = rest[2 : 2+end]
		}
		return host == "" || validDomain(host)
	}
	if !strings.HasPrefix(rest, "//") {
		return true
	}
	host, port := splitAuthority(rest[2:], false)
	return validPort(port) && validOpaqueHost(host)
}

// splitAuthority takes the authority off the front of what follows the
// slashes - up to the first / ? # (and \ for the special schemes), after the
// last @ - and splits it into host and port
func splitAuthority(s string, special bool) (host, port string) {
	stops := "/?#"
	if special {
		stops += `\`
	}
	if i := strings.IndexAny(s, stops); i >= 0 {
		s = s[:i]
	}
	if i := strings.LastIndexByte(s, '@'); i >= 0 {
		s = s[i+1:]
	}
	if strings.HasPrefix(s, "[") {
		if end := strings.IndexByte(s, ']'); end >= 0 {
			host, after := s[:end+1], s[end+1:]
			if after == "" {
				return host, ""
			}
			if after[0] != ':' {
				return "", "x"
			}
			return host, after[1:]
		}
	}
	host, port, _ = strings.Cut(s, ":")
	return host, port
}

// a port is digits, at most 65535, or nothing at all
func validPort(port string) bool {
	if port == "" {
		return true
	}
	if !allDigits(port) {
		return false
	}
	n, err := strconv.Atoi(port)
	return err == nil && n <= 65535
}

// the code points no host may hold, and the further ones no domain may
const forbiddenHost = "\x00\t\n\r #/:<>?@[\\]^|"
const forbiddenDomain = forbiddenHost + "%\x7f"

func validIPv6(host string) bool {
	inner := host[1 : len(host)-1]
	ip := net.ParseIP(inner)
	return ip != nil && strings.Contains(inner, ":")
}

func validDomain(host string) bool {
	if strings.HasPrefix(host, "[") {
		return strings.HasSuffix(host, "]") && validIPv6(host)
	}
	// "" for a broken escape, which no host survives
	decoded, _ := url.PathUnescape(host)
	if decoded == "" {
		return false
	}
	for i := 0; i < len(decoded); i++ {
		c := decoded[i]
		if c < 0x20 || c >= 0x7f || strings.IndexByte(forbiddenDomain, c) >= 0 {
			return false
		}
	}
	if !validPunycodeLabels(decoded) {
		return false
	}
	if endsInANumber(decoded) {
		return validIPv4(decoded)
	}
	return true
}

func validOpaqueHost(host string) bool {
	if strings.HasPrefix(host, "[") {
		return strings.HasSuffix(host, "]") && validIPv6(host)
	}
	for i := 0; i < len(host); i++ {
		if strings.IndexByte(forbiddenHost, host[i]) >= 0 {
			return false
		}
	}
	return true
}

// the host's last label - one trailing dot dropped - is a number, so the
// whole host must be an ipv4 address
func endsInANumber(host string) bool {
	labels := strings.Split(host, ".")
	if labels[len(labels)-1] == "" {
		if len(labels) == 1 {
			return false
		}
		labels = labels[:len(labels)-1]
	}
	// all digits is a number even when it is no ipv4 part: 09 is a bad
	// octal, and the host is refused rather than read as a name (found by
	// the verifier of phase 6)
	last := labels[len(labels)-1]
	if allDigits(last) {
		return true
	}
	_, ok := ipv4Part(last)
	return ok
}

// an ipv4 part as the WHATWG parser reads it: 0x hex, a leading 0 octal,
// decimal otherwise
func ipv4Part(s string) (*big.Int, bool) {
	if s == "" {
		return nil, false
	}
	base := 10
	switch {
	case len(s) >= 2 && (s[:2] == "0x" || s[:2] == "0X"):
		base, s = 16, s[2:]
		if s == "" {
			return new(big.Int), true
		}
	case len(s) >= 2 && s[0] == '0':
		base, s = 8, s[1:]
	}
	for i := 0; i < len(s); i++ {
		if !strings.ContainsRune("0123456789abcdefABCDEF"[:digitsFor(base)], rune(s[i])) {
			return nil, false
		}
	}
	n, ok := new(big.Int).SetString(s, base)
	return n, ok
}

func digitsFor(base int) int {
	switch base {
	case 16:
		return 22
	case 8:
		return 8
	case 2:
		return 2
	}
	return 10
}

func validIPv4(host string) bool {
	parts := strings.Split(host, ".")
	if parts[len(parts)-1] == "" && len(parts) > 1 {
		parts = parts[:len(parts)-1]
	}
	if len(parts) > 4 {
		return false
	}
	for i, p := range parts {
		n, ok := ipv4Part(p)
		if !ok {
			return false
		}
		limit := big.NewInt(255)
		if i == len(parts)-1 {
			limit = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), uint(8*(5-len(parts)))), big.NewInt(1))
		}
		if n.Cmp(limit) > 0 {
			return false
		}
	}
	return true
}

// validPunycodeLabels refuses a label written as punycode (xn--...) that
// does not decode, as the javascript parser does; the go side has no idna
// table to say more about one that does
func validPunycodeLabels(host string) bool {
	for _, label := range strings.Split(host, ".") {
		if len(label) >= 4 && strings.EqualFold(label[:4], "xn--") && !decodesAsPunycode(strings.ToLower(label[4:])) {
			return false
		}
	}
	return true
}

// decodesAsPunycode is RFC 3492's decoder, reporting only whether it
// succeeds on a label UTS 46 allows
func decodesAsPunycode(s string) bool {
	const base, tmin, tmax, skew, damp = 36, 1, 26, 38, 700
	n, bias, out := 128, 72, 0
	var runes []rune
	if i := strings.LastIndexByte(s, '-'); i >= 0 {
		for j := 0; j < i; j++ {
			if s[j] >= 0x80 {
				return false
			}
		}
		runes = []rune(s[:i])
		out, s = i, s[i+1:]
	}
	for i, pos := 0, 0; pos < len(s); {
		oldi, w := i, 1
		for k := base; ; k += base {
			if pos >= len(s) {
				return false
			}
			c := s[pos]
			pos++
			var digit int
			switch {
			case '0' <= c && c <= '9':
				digit = int(c-'0') + 26
			case 'a' <= c && c <= 'z':
				digit = int(c - 'a')
			default:
				return false
			}
			if digit > (math.MaxInt32-i)/w {
				return false
			}
			i += digit * w
			t := k - bias
			if t < tmin {
				t = tmin
			} else if t > tmax {
				t = tmax
			}
			if digit < t {
				break
			}
			if w > math.MaxInt32/(base-t) {
				return false
			}
			w *= base - t
		}
		out++
		delta := i - oldi
		if oldi == 0 {
			delta /= damp
		} else {
			delta /= 2
		}
		delta += delta / out
		k := 0
		for delta > ((base-tmin)*tmax)/2 {
			delta /= base - tmin
			k += base
		}
		bias = k + (base-tmin+1)*delta/(delta+skew)
		if i/out > math.MaxInt32-n {
			return false
		}
		n += i / out
		i %= out
		// an encoded ascii or c1 control is never a label UTS 46 allows
		if n < 0xa0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff) {
			return false
		}
		runes = slices.Insert(runes, i, rune(n))
		i++
	}
	return out > 0 && allowedLabel(runes)
}

// allowedLabel is what a decoded label must be for the javascript parser to
// take it: not plain ascii - an xn-- label that decodes to ascii is not one
// UTS 46 allows - and made of letters, marks, digits and hyphens. A zero
// width joiner, a soft hyphen, a no-break space or an unassigned code point
// was taken here and refused there (found by hunt 3). Without the
// normalization tables, a combining diacritic of U+0300-U+036F straight
// after an ascii letter stands for the non-NFC spellings - e and U+0301 is
// é decomposed: refused, stricter than the parser where it errs, never
// looser
func allowedLabel(runes []rune) bool {
	ascii := true
	for i, r := range runes {
		if r >= 0x80 {
			ascii = false
		}
		switch {
		case r == '-', unicode.IsLetter(r), unicode.IsDigit(r):
		case unicode.IsMark(r):
			if i == 0 || (r >= 0x300 && r <= 0x36f && runes[i-1] < 0x80) {
				return false
			}
		default:
			return false
		}
	}
	return !ascii
}
