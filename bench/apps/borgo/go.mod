module benchborgo

go 1.25.0

require github.com/LuigiDavideMicca/borgo v0.0.0

require (
	golang.org/x/mod v0.38.0 // indirect
	golang.org/x/sync v0.22.0 // indirect
	golang.org/x/tools v0.48.0 // indirect
)

// the benchmark measures the borgo in this checkout, not a published release
replace github.com/LuigiDavideMicca/borgo => ../../..

tool github.com/LuigiDavideMicca/borgo/cmd/borgogen
