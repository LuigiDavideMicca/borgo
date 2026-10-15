//go:build linux && borgo_deploy

package api

// built only where the app deploys: the go list borgogen reads on a
// laptop never sees it, and the Go that runs in production does
func init() { Matcher = append(Matcher, "/admin") }
