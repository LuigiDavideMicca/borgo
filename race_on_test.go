//go:build race

package borgo

// the race detector instruments every allocation: a test that measures what
// a response allocates has to know it is running under it
const raceEnabled = true
