package api

// An unclosed generic in a replacement is not a mistake in one type: the text
// is spliced in whole, so the "<" swallows the rest of the file.
//
//borgo:type Thing Array<string

type Thing struct {
	Name string `json:"name"`
}
