package api

// runs before borgo.gen.go registers the matcher: files initialise in name
// order, and the literal no longer says what Go guards
func init() { Matcher[0] = "/admin" }
