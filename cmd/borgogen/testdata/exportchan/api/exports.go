package api

import "context"

//borgo:export
func Watch(ctx context.Context, events chan string) (bool, error) { return false, nil }
