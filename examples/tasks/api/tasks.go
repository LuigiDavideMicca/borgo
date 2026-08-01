package api

import (
	"errors"
	"net/http"

	"github.com/LuigiDavideMicca/borgo"
	"gorm.io/gorm"

	"tasks/db"
)

//borgo:type gorm.io/gorm.DeletedAt string | null

type Task struct {
	gorm.Model
	Title string `json:"title"`
	Body  string `json:"body"`
}

type TaskCreate struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}

type TaskList struct {
	Tasks []Task `json:"tasks"`
}

type TaskItem struct {
	Task Task `json:"task"`
}

type Deleted struct {
	Deleted bool `json:"deleted"`
}

type Cleared struct {
	Cleared int64 `json:"cleared"`
}

// a helper: borgogen follows it, so callers still get the TaskItem type
func respondTask(w http.ResponseWriter, status int, task Task) {
	borgo.JSON(w, status, TaskItem{Task: task})
}

//borgo:route GET /api/tasks
func ListTasks(w http.ResponseWriter, r *http.Request) {
	// empty, not nil: a nil slice marshals to null and the client's Array<Task>
	// would be a lie the first time the list is empty
	tasks := []Task{}
	if err := db.DB.Order("created_at desc").Find(&tasks).Error; err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	borgo.JSON(w, http.StatusOK, TaskList{Tasks: tasks})
}

//borgo:route POST /api/tasks
func CreateTask(w http.ResponseWriter, r *http.Request) {
	body, err := borgo.Bind[TaskCreate](r)
	if err != nil {
		borgo.BindError(w, err)
		return
	}

	task := Task{Title: body.Title, Body: body.Body}
	if err := db.DB.Create(&task).Error; err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	events.Publish("task-created", task)
	go borgo.Push("live", "task-created", task.Title)
	respondTask(w, http.StatusCreated, task)
}

//borgo:route GET /api/tasks/{id}
func GetTask(w http.ResponseWriter, r *http.Request) {
	var task Task
	err := db.DB.First(&task, "id = ?", r.PathValue("id")).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		http.Error(w, "task not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	respondTask(w, http.StatusOK, task)
}

// clearing the whole list is destructive, so it sits behind borgo.Authed:
// logged-out callers get a json 401 and the handler never runs
func ClearTasks(w http.ResponseWriter, r *http.Request) {
	result := db.DB.Where("1 = 1").Delete(&Task{})
	if result.Error != nil {
		http.Error(w, result.Error.Error(), http.StatusInternalServerError)
		return
	}
	events.Publish("task-deleted", "all")
	borgo.WriteJSON(w, http.StatusOK, Cleared{Cleared: result.RowsAffected})
}

func init() {
	borgo.Handle("DELETE /api/tasks", borgo.Authed(ClearTasks))
}

//borgo:route DELETE /api/tasks/{id}
func DeleteTask(w http.ResponseWriter, r *http.Request) {
	if err := db.DB.Delete(&Task{}, "id = ?", r.PathValue("id")).Error; err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	events.Publish("task-deleted", r.PathValue("id"))
	borgo.WriteJSON(w, http.StatusOK, Deleted{Deleted: true})
}
