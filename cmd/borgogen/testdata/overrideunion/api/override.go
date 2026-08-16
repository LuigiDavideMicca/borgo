package api

import (
	"encoding/json"
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
)

// Soft stands for the real case this fixture exists for: examples/tasks maps
// gorm.DeletedAt with `//borgo:type gorm.io/gorm.DeletedAt string | null`. The
// replacement is hand written TypeScript that is already a union, and already
// carries a null, and the generator has no structure for it - it is a leaf of
// somebody else's text. Widening such a leaf to admit null stacks a second one
// on it rather than merging with the one inside, because nothing looks inside a
// member any more.
//
//borgo:type Soft string | null
type Soft struct {
	Raw string `json:"raw"`
}

func (Soft) MarshalJSON() ([]byte, error) { return json.Marshal(nil) }

// Handler stands for every replacement that binds looser than the union a
// nullable position wraps it in. Spliced in bare, "(v: string) => void"
// widened to "(v: string) => void | null": a function returning void|null,
// which is a different type, and one no compiler anywhere complains about.
//
//borgo:type Handler (v: string) => void
type Handler struct {
	Name string `json:"name"`
}

// Tags is nilable in Go, and the replacement text replaces the shape, not the
// nil: json.Marshal of a nil Tags is "null" whatever Array<string> says.
//
//borgo:type Tags Array<string>
type Tags []string

// Holder puts those leaves in every position that widens them.
type Holder struct {
	One   Soft            `json:"one"`
	Ptr   *Soft           `json:"ptr"`
	Many  []Soft          `json:"many"`
	Keyed map[string]Soft `json:"keyed"`
	Fn    *Handler        `json:"fn"`
	Tags  Tags            `json:"tags"`
}

//borgo:route GET /api/soft
func GetSoft(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Holder{})
}
