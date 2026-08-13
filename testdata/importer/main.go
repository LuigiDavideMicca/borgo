// Command importer is what TestARefusedHashSlotCountDoesNotKillAnImporter
// runs: a binary that imports borgo and never serves. A refusal borgo can only
// discover while it is initialising - BORGO_HASH_SLOTS - must not stop this
// program from reaching main, and must still be there to be read when it asks.
//
// It lives under testdata so the go tool leaves it out of ./... ; the test
// builds it by name.
package main

import (
	"fmt"
	"os"

	"github.com/LuigiDavideMicca/borgo"
)

func main() {
	fmt.Println("reached main")
	if err := borgo.CheckEnv(); err != nil {
		fmt.Println("CheckEnv:", err)
	}
	// the second half of the test: a cap taken at init, then a variable
	// unset under it
	if os.Getenv("IMPORTER_UNSETS_HASH_SLOTS") == "" {
		return
	}
	os.Unsetenv("BORGO_HASH_SLOTS")
	if err := borgo.CheckEnv(); err != nil {
		fmt.Println("CheckEnv after unset:", err)
	}
}
