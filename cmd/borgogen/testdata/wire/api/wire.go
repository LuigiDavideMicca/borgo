package api

import (
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

//borgo:route GET /api/empty
func GetEmpty(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Empty{})
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
