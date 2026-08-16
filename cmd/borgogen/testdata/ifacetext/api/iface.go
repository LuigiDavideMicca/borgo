package api

import (
	"encoding"
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

// Coded is the domain interface an app writes when several types have to reach
// the wire as one text. It embeds encoding.TextMarshaler, so every value that
// satisfies it marshals as a JSON string - and the interface itself can be nil,
// which encoding/json writes as null without calling the method at all:
//
//	json.Marshal(Box{}) is {"code":null,"free":null,"many":null}
type Coded interface {
	encoding.TextMarshaler
	Code() int
}

type Warn struct{}

func (Warn) MarshalText() ([]byte, error) { return []byte("warn"), nil }
func (Warn) Code() int                    { return 2 }

type Box struct {
	Code Coded   `json:"code"`
	Free any     `json:"free"`
	Many []Coded `json:"many"`
}

//borgo:route GET /api/box
func GetBox(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Box{})
}
