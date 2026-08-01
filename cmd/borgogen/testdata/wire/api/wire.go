package api

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/LuigiDavideMicca/borgo"
)

type Tags []string

// Empty is the shape a handler returns when it found nothing, which is the
// common case the browser has to survive. json.Marshal(Empty{}) writes exactly
//
//	{"items":null,"m":null,"raw":null,"nest":null,"named":null,"arr":[0,0]}
//
// so every field but arr arrives as null: a nil slice, map or []byte is never
// "[]", "{}" or "".
type Empty struct {
	Items []int          `json:"items"`
	M     map[string]int `json:"m"`
	Raw   []byte         `json:"raw"`
	Nest  [][]string     `json:"nest"`
	Named Tags           `json:"named"`
	Arr   [2]int         `json:"arr"`
}

// Stamped's At promotes time.Time's MarshalJSON through an anonymous struct,
// so it reaches the wire as a JSON string and never as the object its X field
// suggests. json.Marshal(Stamped{}) writes exactly
//
//	{"at":"0001-01-01T00:00:00Z","plain":{"n":0}}
type Stamped struct {
	At struct {
		time.Time
		X int `json:"x"`
	} `json:"at"`
	Plain struct {
		N int `json:"n"`
	} `json:"plain"`
}

type Label struct{ N int }

func (Label) MarshalText() ([]byte, error) { return []byte("label"), nil }

type PtrLabel struct{ N int }

func (p *PtrLabel) MarshalText() ([]byte, error) { return []byte("ptr"), nil }

// An anonymous struct promotes MarshalText too, and a pointer receiver still
// only runs where the value is addressable. json.Marshal of a Tagged holding
// one element in many writes exactly
//
//	{"l":"label","p":{"N":0,"extra":0},"many":["ptr"]}
type Tagged struct {
	L struct {
		Label
		Extra int `json:"extra"`
	} `json:"l"`
	P struct {
		PtrLabel
		Extra int `json:"extra"`
	} `json:"p"`
	Many []struct {
		PtrLabel
		Extra int `json:"extra"`
	} `json:"many"`
}

// A float key is not a key encoding/json can name: json.Marshal(Keys{}) fails
// with "json: unsupported type: map[float64]int" even with the map nil, so
// there is no shape to promise for fees. An integer key is fine.
type Keys struct {
	Fees  map[float64]int `json:"fees"`
	Sizes map[uint8]int   `json:"sizes"`
}

// json.Number is typed string in Go and carries a bare number on the wire.
// Amount is a copy of it, not it, so encoding/json quotes Amount like any other
// string-kinded type. json.Marshal of a Nums holding "1", 12.5, 2, 3 and "3":
//
//	{"n":1,"np":12.5,"ns":[2,3],"amt":"3"}
type Amount json.Number

type Nums struct {
	N   json.Number   `json:"n"`
	NP  *json.Number  `json:"np"`
	NS  []json.Number `json:"ns"`
	Amt Amount        `json:"amt"`
}

// PM's MarshalJSON is on the pointer receiver, so encoding/json calls it only
// where the value it holds is addressable - never the root of a json.Marshal,
// a plain struct field of it or a map value, always a slice element or
// something behind a pointer. json.Marshal of a PMHolder with one element in
// many, a non-nil ptr and one entry in keyed:
//
//	{"one":{"x":0},"many":["pm"],"ptr":"pm","keyed":{"k":{"x":0}}}
type PM struct {
	X int `json:"x"`
}

func (p *PM) MarshalJSON() ([]byte, error) { return []byte(`"pm"`), nil }

type PMHolder struct {
	One   PM            `json:"one"`
	Many  []PM          `json:"many"`
	Ptr   *PM           `json:"ptr"`
	Keyed map[string]PM `json:"keyed"`
}

// KeyBoth carries both marshalers. encoding/json's resolveKeyName never
// consults MarshalJSON for a key, only the kind and then TextMarshaler, so the
// map is a plain object: json.Marshal(MapBoth{map[KeyBoth]int{{5}: 5}}) is
//
//	{"m":{"kt":5}}
type KeyBoth struct{ N int }

func (KeyBoth) MarshalJSON() ([]byte, error) { return []byte(`"kj"`), nil }
func (KeyBoth) MarshalText() ([]byte, error) { return []byte("kt"), nil }

type MapBoth struct {
	M map[KeyBoth]int `json:"m"`
}

// []byte and []uint8 are one type spelled two ways, and json.Marshal calls a
// MarshalJSON returning either: json.Marshal(Uint8Marshal{}) is {"u":"u8"}.
type Uint8Marshal struct {
	U U8 `json:"u"`
}

type U8 struct {
	X int `json:"x"`
}

func (U8) MarshalJSON() ([]uint8, error) { return []byte(`"u8"`), nil }

//borgo:route GET /api/empty
func GetEmpty(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Empty{})
}

//borgo:route GET /api/nums
func GetNums(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Nums{})
}

//borgo:route GET /api/pm
func GetPM(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, PMHolder{})
}

//borgo:route GET /api/mapboth
func GetMapBoth(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, MapBoth{})
}

//borgo:route GET /api/uint8
func GetUint8(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Uint8Marshal{})
}

// Two nullable answers under one route: the union has to carry one null, not
// one per alternative.
//
//borgo:route GET /api/either
func GetEither(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Has("tags") {
		borgo.JSON(w, http.StatusOK, Tags{})
		return
	}
	borgo.JSON(w, http.StatusOK, []int{})
}

//borgo:route GET /api/stamped
func GetStamped(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Stamped{})
}

//borgo:route GET /api/keys
func GetKeys(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Keys{})
}

//borgo:route GET /api/tagged
func GetTagged(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Tagged{})
}
