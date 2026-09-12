package api

import (
	"context"
	"errors"
	"time"
)

type Member struct {
	UserID int64  `json:"userId"`
	Role   string `json:"role"`
	// never crosses: json skips it, so the export is still callable
	Notify chan string `json:"-"`
}

//borgo:export
func Membership(ctx context.Context, userID int64, slug string) (*Member, error) {
	return nil, errors.New("not in the fixture")
}

// error only: the stub resolves to null
//
//borgo:export
func Forget(ctx context.Context, userID int64) error {
	return nil
}

// a parameter from another package, so the adapter must import it
//
//borgo:export
func Seen(ctx context.Context, at time.Time) (bool, error) {
	return at.IsZero(), nil
}
