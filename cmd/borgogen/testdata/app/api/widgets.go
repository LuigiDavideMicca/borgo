package api

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/LuigiDavideMicca/borgo"
)

//borgo:type Money string

type Money struct {
	cents int
}

func (Money) MarshalJSON() ([]byte, error) { return []byte(`"0.00"`), nil }

type Meta struct {
	Created time.Time `json:"created"`
}

type Widget struct {
	Meta
	ID     int             `json:"id"`
	Name   string          `json:"name"`
	Tags   []string        `json:"tags,omitempty"`
	Price  Money           `json:"price"`
	Notes  *string         `json:"notes"`
	Attrs  map[string]int  `json:"attrs"`
	Raw    json.RawMessage `json:"raw"`
	Counts map[int]string  `json:"counts"`
	Flags  map[bool]int    `json:"flags"`
	Secret string          `json:"-"`
	hidden bool
}

type WidgetList struct {
	Widgets []Widget `json:"widgets"`
}

type WidgetCreate struct {
	Name string `json:"name"`
}

type Deleted struct {
	OK bool `json:"ok"`
}

func respondWidget(w http.ResponseWriter, status int, widget Widget) {
	borgo.JSON(w, status, widget)
}

//borgo:route GET /api/widgets
func ListWidgets(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, WidgetList{})
}

//borgo:route POST /api/widgets
func CreateWidget(w http.ResponseWriter, r *http.Request) {
	body, err := borgo.Bind[WidgetCreate](r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	widget := Widget{Name: body.Name}
	borgo.Push("widgets", "created", widget)
	respondWidget(w, http.StatusCreated, widget)
}

//borgo:route PUT /api/widgets/{id}
func UpdateWidget(w http.ResponseWriter, r *http.Request) {
	body, err := borgo.BindMax[WidgetCreate](r, 4<<20)
	if err != nil {
		borgo.BindError(w, err)
		return
	}
	respondWidget(w, http.StatusOK, Widget{Name: body.Name})
}

type ErrResp struct {
	Error string `json:"error"`
}

//borgo:route GET /api/widgets/{id}
func GetWidget(w http.ResponseWriter, r *http.Request) {
	if r.PathValue("id") == "" {
		borgo.JSON(w, http.StatusNotFound, ErrResp{Error: "not found"})
		return
	}
	borgo.WriteJSON(w, http.StatusBadGateway, ErrResp{Error: "upstream"})
	borgo.JSON(w, http.StatusOK, Widget{})
}

//borgo:route DELETE /api/widgets/{id}
func DeleteWidget(w http.ResponseWriter, r *http.Request) {
	borgo.Push("widgets", "deleted", 1)
	borgo.Push("widgets", "deleted", "gone")
	borgo.WriteJSON(w, http.StatusOK, Deleted{OK: true})
}

func manual(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, "plain")
}

func secret(w http.ResponseWriter, r *http.Request) {
	borgo.JSON(w, http.StatusOK, Deleted{OK: true})
}

func init() {
	borgo.Handle("GET /api/manual", manual)
	borgo.Handle("GET /api/secret", borgo.Authed(secret))
}
