package borgo

import (
	"fmt"
	"os"
	"strconv"
)

// wsAllowNoOriginFromEnv reads BORGO_WS_ALLOW_NO_ORIGIN, the switch that
// admits a websocket handshake with no Origin header. Browsers always send
// one, so this exists for non-browser clients - and it re-admits every
// originless caller with them, which is the whole hole it opens. The grammar
// is every other borgo boolean's: "1"/"true" or "0"/"false", unset means
// refused, and anything else stops the boot - the refusal text a client
// reads tells it to set "=1", and a server that took "yes" here and refused
// it there would be two servers.
func wsAllowNoOriginFromEnv() (bool, error) {
	v := os.Getenv("BORGO_WS_ALLOW_NO_ORIGIN")
	if v == "" {
		return false, nil
	}
	if err := envTextRefusal("BORGO_WS_ALLOW_NO_ORIGIN", v); err != nil {
		return false, err
	}
	on, err := strconv.ParseBool(v)
	if err != nil {
		return false, fmt.Errorf(`borgo: BORGO_WS_ALLOW_NO_ORIGIN: invalid value %q (want "1"/"true" or "0"/"false"; unset means a handshake with no Origin is refused)`, v)
	}
	return on, nil
}
