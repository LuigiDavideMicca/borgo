package main

import (
	"encoding/json"
	"strings"
)

// templateText is s as the text of a TypeScript template literal: a
// backslash, a backtick and "${" would end it or open an interpolation, and
// an event name holding one made the whole generated file a parse error,
// every route's types with it (found by hunt 3)
func templateText(s string) string {
	bs := string(rune(92))
	return strings.NewReplacer(bs, bs+bs, "`", bs+"`", "${", bs+"${").Replace(s)
}

// tsString is s as a TypeScript string literal. Go's %q writes escapes
// TypeScript reads otherwise - \a is "a" there, \U0001F600 is "U0001F600" -
// so a key holding one named a route or event the app never had; JSON's
// escapes are TypeScript's own (found by hunt 3)
func tsString(s string) string {
	var b strings.Builder
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	e.Encode(s)
	return strings.TrimSuffix(b.String(), string(rune(10)))
}

// eventKey is a WsEvents template key as written: its topic part was
// escaped with its pattern, and the event is the app's literal
func eventKey(k string) string {
	at := strings.LastIndex(k, "/")
	return k[:at+1] + templateText(k[at+1:])
}
