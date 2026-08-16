package api

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/LuigiDavideMicca/borgo"
)

// Code converts itself in both directions and identically - MarshalText and
// UnmarshalText both - so it is a string on the wire either way. It is here
// because null is still accepted for it: encoding/json answers a null literal
// before it ever reaches the method.
type Code struct{ Raw string }

func (c Code) MarshalText() ([]byte, error)  { return []byte(c.Raw), nil }
func (c *Code) UnmarshalText(b []byte) error { c.Raw = string(b); return nil }

type Inner struct {
	A int `json:"a"`
}

// Every is answered with as well as bound, so both declarations of it sit in
// the generated file and the asymmetry between reading and writing is the diff
// between them. One field per kind borgogen renders.
type Every struct {
	Flag    bool              `json:"flag"`
	Count   int               `json:"count"`
	Ratio   float64           `json:"ratio"`
	Name    string            `json:"name"`
	Ptr     *string           `json:"ptr"`
	List    []string          `json:"list"`
	Fixed   [2]string         `json:"fixed"`
	Dict    map[string]string `json:"dict"`
	Nested  Inner             `json:"nested"`
	Blob    []byte            `json:"blob"`
	At      time.Time         `json:"at"`
	Amount  json.Number       `json:"amount"`
	Free    any               `json:"free"`
	Code    Code              `json:"code"`
	Opt     string            `json:"opt,omitempty"`
	Quoted  int               `json:"quoted,string"`
	Skipped string            `json:"-"`
	hidden  string
}

// Tags has no fields for the decoder's leniency to apply to, so it renders the
// same text in both directions and keeps one declaration.
type Tags []string

// Loose is the case dirDiffers over-approximates: its one property is already
// optional and already nullable going out, so the second declaration it gets is
// the same text as the first.
type Loose struct {
	Ptr *string `json:"ptr,omitempty"`
}

//borgo:route POST /api/every
func PostEvery(w http.ResponseWriter, r *http.Request) {
	v, err := borgo.Bind[Every](r)
	if err != nil {
		borgo.BindError(w, err)
		return
	}
	v.hidden = v.Skipped
	borgo.JSON(w, http.StatusOK, v)
}

//borgo:route POST /api/tags
func PostTags(w http.ResponseWriter, r *http.Request) {
	v, err := borgo.Bind[Tags](r)
	if err != nil {
		borgo.BindError(w, err)
		return
	}
	borgo.JSON(w, http.StatusOK, v)
}

//borgo:route POST /api/loose
func PostLoose(w http.ResponseWriter, r *http.Request) {
	v, err := borgo.Bind[Loose](r)
	if err != nil {
		borgo.BindError(w, err)
		return
	}
	borgo.JSON(w, http.StatusOK, v)
}
