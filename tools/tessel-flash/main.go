// Command tessel-flash updates, repairs and configures a Tessaya R1 over its USB cable, with no Tessaya install.
package main

import (
	"os"

	"github.com/RabHanz/tessaya/tools/tessel-flash/cli"
)

func main() {
	st, err := os.Stdin.Stat()
	tty := err == nil && st.Mode()&os.ModeCharDevice != 0
	os.Exit(cli.Run(os.Args[1:], os.Stdin, os.Stdout, tty))
}
