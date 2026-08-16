package api

import (
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

// Slug goes out as a string and comes back as an object: it has a MarshalText
// and no UnmarshalText, which is what a hand written id or enum type looks
// like when only the writing side was ever needed. Typing a request body with
// the marshal rules told the caller to send the one thing the server rejects.
type Slug struct {
	Raw string `json:"raw"`
}

func (s Slug) MarshalText() ([]byte, error) { return []byte(s.Raw), nil }

// Stamp is the same disagreement the other way round. Its UnmarshalJSON is on
// the pointer receiver - which is where practically every one of them is - and
// borgo.Bind declares its own value and decodes into &v, so the decoder does
// call it and the body it accepts is nothing like the Go shape.
type Stamp struct {
	Unix int64 `json:"unix"`
}

func (s *Stamp) UnmarshalJSON([]byte) error { return nil }

// Create is answered with as well as bound, which is ordinary: create a thing,
// get the thing back.
type Create struct {
	Slug  Slug   `json:"slug"`
	Stamp Stamp  `json:"stamp"`
	Note  string `json:"note"`
}

// Plain converts nothing itself, so both directions are the one shape and one
// declaration answers for them - the case that must not grow a second name.
type Plain struct {
	Name string `json:"name"`
}

//borgo:route POST /api/things
func CreateThing(w http.ResponseWriter, r *http.Request) {
	v, err := borgo.Bind[Create](r)
	if err != nil {
		borgo.BindError(w, err)
		return
	}
	borgo.JSON(w, http.StatusOK, v)
}

//borgo:route POST /api/plain
func CreatePlain(w http.ResponseWriter, r *http.Request) {
	v, err := borgo.Bind[Plain](r)
	if err != nil {
		borgo.BindError(w, err)
		return
	}
	borgo.JSON(w, http.StatusOK, v)
}
