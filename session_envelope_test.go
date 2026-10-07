package borgo

import (
	"bytes"
	"encoding/json"
	"testing"
)

// what the hand-read envelope answers, encoding/json answers too: the fast
// path may decline any envelope, never read one differently
func sameAsJSON(t testing.TB, raw []byte) {
	fast, ok := fastEnvelope(raw)
	if !ok {
		return
	}
	var slow sessionEnvelope
	if err := json.Unmarshal(raw, &slow); err != nil {
		t.Fatalf("%q: read by hand, refused by encoding/json: %v", raw, err)
	}
	if fast.Exp != slow.Exp || fast.Iat != slow.Iat || !bytes.Equal(fast.Data, slow.Data) {
		t.Fatalf("%q: by hand %+v, encoding/json %+v", raw, fast, slow)
	}
}

func TestEnvelopeReadByHandAsEncodingJSONReadsIt(t *testing.T) {
	for _, data := range []string{`{"id":7}`, `null`, `"s"`, `[1,{"a":"}"}]`, `{"a":"\"}\\"}`, `{}`, `0`, `-1.5e3`} {
		raw, err := json.Marshal(sessionEnvelope{Exp: 1 << 40, Iat: 1 << 41, Data: json.RawMessage(data)})
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := fastEnvelope(raw); !ok {
			t.Errorf("%s: the envelope SetSession writes was not read by hand", raw)
		}
		sameAsJSON(t, raw)
	}
	// what the fast path must leave to encoding/json, which still reads it
	for _, raw := range []string{
		`{"exp":5,"data":{"id":1}}`,                      // an envelope from before iat
		`{"exp":5,"iat":6,"data":{"id":1},"later":true}`, // a field a later version adds
		`{"iat":6,"exp":5,"data":1}`,                     // another order
		`{"exp":5, "iat":6, "data":1}`,                   // whitespace
	} {
		if _, ok := fastEnvelope([]byte(raw)); ok {
			t.Errorf("%s: read by hand", raw)
		}
		e, ok := decodeEnvelope([]byte(raw))
		if !ok || e.Exp != 5 {
			t.Errorf("%s: %+v %v", raw, e, ok)
		}
	}
	for _, raw := range []string{`{"exp":`, `{"exp":-,"iat":1,"data":1}`, `{"exp":99999999999999999999,"iat":1,"data":1}`, `{"exp":1,"iat":1,"data":}`, `{"exp":1,"iat":1,"data":{}`, `{"exp":5.0,"iat":6,"data":1}`, `{"exp":1,"iat":1,"data": 1}`, `{"exp":00,"iat":0,"data":null}`, `{"exp":1,"iat":1,"data":12`, "{\"exp\":1,\"iat\":1,\"data\":\t1}", "{\"exp\":1,\"iat\":1,\"data\":1\n}", "{\"exp\":1,\"iat\":1,\"data\":1\r}", `{"exp":1,"iat":-01,"data":null}`, `{"exp":1,"iat":1,"data":1 }`} {
		if _, ok := fastEnvelope([]byte(raw)); ok {
			t.Errorf("%s: read by hand", raw)
		}
	}
}

func FuzzEnvelopeReadByHand(f *testing.F) {
	for _, s := range []string{`{"exp":1,"iat":2,"data":{"a":1}}`, `{"exp":-3,"iat":0,"data":null}`, `{"exp":1,"iat":2,"data":"}"}`} {
		f.Add([]byte(s))
	}
	f.Fuzz(func(t *testing.T, raw []byte) { sameAsJSON(t, raw) })
}

// the reason for the hand-read path: the envelope SetSession writes, and
// one with a negative expiry, decode without a single allocation
func TestEnvelopeTheAppWritesDecodesWithoutAllocating(t *testing.T) {
	for _, exp := range []int64{1 << 40, -3} {
		raw, _ := json.Marshal(sessionEnvelope{Exp: exp, Iat: 9, Data: json.RawMessage(`{"id":7,"roles":["a"]}`)})
		if e, ok := decodeEnvelope(raw); !ok || e.Exp != exp || e.Iat != 9 {
			t.Fatalf("%s: %+v %v", raw, e, ok)
		}
		if n := testing.AllocsPerRun(100, func() { decodeEnvelope(raw) }); n != 0 {
			t.Errorf("%s: %v allocations", raw, n)
		}
	}
}
