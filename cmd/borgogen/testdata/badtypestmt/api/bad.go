package api

// Nothing looks inside a replacement once it is collected, so a ";" in one
// ends the declaration it is written into and leaves the rest loose in the
// generated file.
//
//borgo:type Thing string; export const leaked = 1

type Thing struct {
	Name string `json:"name"`
}
