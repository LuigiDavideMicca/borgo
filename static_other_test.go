//go:build !windows

package borgo

import "testing"

// no short names off windows: the alias test has nothing to ask
func shortName(*testing.T, string) string { return "" }
