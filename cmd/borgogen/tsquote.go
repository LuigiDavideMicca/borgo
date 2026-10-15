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

// eventKey is a WsEvents template key as written: its topic part - no topic
// holds a "/", an event may, so the first one ends it - was
// escaped with its pattern, and the event is the app's literal
func eventKey(k string) string {
	at := strings.Index(k, "/")
	return k[:at+1] + templateText(k[at+1:])
}

// the names borgo-framework declares in its own module scope: the generated
// file writes app types inside its declare module block, where these names
// resolve to borgo's - an app type Channel became borgo's Channel (found by
// the verifier of hunt 3). Renaming the app's type broke every import of it
// (found rebuilding piazza, a chat app with a Channel), so the type keeps its
// name and the block reaches it through an alias declared outside it
var borgoModuleNames = []string{
	"ApiRoutes", "Channel", "EventPairs", "EventsFor", "Island", "IslandProps",
	"PublishArgs", "SubscribeOptions", "TopicEventName", "TopicEvents", "WsEvents",
}

const moduleAliasPrefix = "__app_"

// shadowedByModule is the app types the generated file declares under one of
// borgo-framework's names
func shadowedByModule(defs []string) map[string]bool {
	out := map[string]bool{}
	for _, name := range borgoModuleNames {
		for _, def := range defs {
			if strings.Contains(def, "export interface "+name+" ") || strings.Contains(def, "export type "+name+" =") {
				out[name] = true
			}
		}
	}
	return out
}

// qualifyForModule rewrites a type expression written inside the declare
// module block so a shadowed name reaches the app's type through its alias.
// String literal types are left as they are: only identifiers change
func qualifyForModule(expr string, shadowed map[string]bool) string {
	if len(shadowed) == 0 {
		return expr
	}
	var b strings.Builder
	for i := 0; i < len(expr); {
		c := expr[i]
		if c == '"' || c == '\'' || c == '`' {
			j := i + 1
			for j < len(expr) && expr[j] != c {
				if expr[j] == byte(92) {
					j++
				}
				j++
			}
			if j < len(expr) {
				j++
			}
			b.WriteString(expr[i:j])
			i = j
			continue
		}
		if isIdentStart(c) {
			j := i + 1
			for j < len(expr) && (isIdentStart(expr[j]) || (expr[j] >= '0' && expr[j] <= '9')) {
				j++
			}
			word := expr[i:j]
			// a property key or a member of a qualified name is not a type
			// (an optional one too: `Channel?:` was rewritten, found by the
			// verifier of this fix)
			key := strings.HasPrefix(expr[j:], ":") || strings.HasPrefix(expr[j:], "?:")
			member := i > 0 && expr[i-1] == '.'
			if shadowed[word] && !key && !member {
				b.WriteString(moduleAliasPrefix + word)
			} else {
				b.WriteString(word)
			}
			i = j
			continue
		}
		b.WriteByte(c)
		i++
	}
	return b.String()
}

func isIdentStart(c byte) bool {
	return c == '_' || c == '$' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}
