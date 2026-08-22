//go:build (freebsd && !amd64 && !arm64) || (openbsd && !386 && !amd64 && !arm && !arm64 && !riscv64)

package borgo

// no kinfo_proc layout was cross-checked for this arch, or its pid is not
// little-endian: the platform stays where the signal probe alone leaves it,
// which is what it did before the check existed
func processIsCorpse(int) bool { return false }
