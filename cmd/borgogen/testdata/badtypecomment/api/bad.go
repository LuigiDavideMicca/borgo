package api

// A directive line runs to its end, so a trailing note is part of the
// replacement - and comments out whatever the generator writes after it.
//
//borgo:type Thing string // the id, as text

type Thing struct {
	Name string `json:"name"`
}
