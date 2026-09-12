package api

import "context"

//borgo:export
func membership(ctx context.Context, userID int64) (bool, error) { return false, nil }

// keeps the unexported function referenced, so the fixture compiles clean
var _ = membership
