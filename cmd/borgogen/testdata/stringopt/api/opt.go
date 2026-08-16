package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

// Cents is an integer kind, so `json:",string"` quotes it - whatever a
// //borgo:type says its shape is. Deciding the quoting on the rendered text
// instead of on the kind left this field promising a template literal for a
// value that arrives quoted.
//
//borgo:type Cents `${number}`
type Cents int64

// Ratio is the same disagreement the other way round: it writes itself as a
// bare number, the directive says so, and `json:",string"` cannot quote it
// because encoding/json looks at the kind and a struct is not a quotable one.
// Reading the rendered "number" and rewriting it to "string" invented quotes
// that never arrive.
//
//borgo:type Ratio number
type Ratio struct {
	N int `json:"n"`
	D int `json:"d"`
}

func (Ratio) MarshalJSON() ([]byte, error) { return []byte("3"), nil }

// Coin marshals itself too, and a marshaler outranks the option: neither
// marshalerEncoder nor textMarshalerEncoder ever looks at opts.quoted.
type Coin int

func (Coin) MarshalJSON() ([]byte, error) { return []byte("9"), nil }

// json.Marshal(Kinds{Amount: 7, Plain: 7}) is
//
//	{"amount":"7","plain":7,"ratio":3,"coin":9,"flag":"false","p":null}
type Kinds struct {
	Amount Cents `json:"amount,string"`
	Plain  Cents `json:"plain"`
	Ratio  Ratio `json:"ratio,string"`
	Coin   Coin  `json:"coin,string"`
	Flag   bool  `json:"flag,string"`
	P      *int  `json:"p,string"`
}

//borgo:route GET /api/kinds
func GetKinds(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Kinds{})
}
