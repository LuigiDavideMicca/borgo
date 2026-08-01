package api

import (
	"net/http"
	"strconv"

	"github.com/LuigiDavideMicca/borgo"
)

// The canonical Go side of the dataset in CONTRACT.md. Its JS twin is
// bench/shared/items.ts; the two must produce identical bytes.

type Item struct {
	ID        int    `json:"id"`
	Title     string `json:"title"`
	Done      bool   `json:"done"`
	Tag       string `json:"tag"`
	CreatedAt string `json:"createdAt"`
}

type ItemList struct {
	Items []Item `json:"items"`
	Count int    `json:"count"`
}

var tags = [4]string{"alpha", "beta", "gamma", "delta"}

const createdAt = "2026-01-01T00:00:00Z"

// built per request on purpose: a cached slice would benchmark the cache
func buildItems(n int) []Item {
	out := make([]Item, n)
	for i := range out {
		id := i + 1
		out[i] = Item{
			ID:        id,
			Title:     "Item " + strconv.Itoa(id),
			Done:      id%3 == 0,
			Tag:       tags[id%4],
			CreatedAt: createdAt,
		}
	}
	return out
}

//borgo:route GET /api/items
func ItemsHandler(w http.ResponseWriter, r *http.Request) {
	n := 100
	if raw := r.URL.Query().Get("n"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			n = parsed
		}
	}
	if n < 1 {
		n = 1
	}
	if n > 1000 {
		n = 1000
	}
	items := buildItems(n)
	borgo.JSON(w, http.StatusOK, ItemList{Items: items, Count: len(items)})
}
