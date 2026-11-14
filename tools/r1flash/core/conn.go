package core

import (
	"bytes"
	"time"
)

// conn reads with pyserial's semantics (read(n), read_until) over a Port whose Read times out.
type conn struct {
	port    Port
	clk     Clock
	buf     []byte
	timeout time.Duration
	set     time.Duration
	baud    int
	tmp     []byte
}

func newConn(p Port, clk Clock) *conn {
	return &conn{port: p, clk: clk, timeout: time.Second, tmp: make([]byte, 8192)}
}

func (c *conn) setTimeout(d time.Duration) {
	if d != c.set {
		_ = c.port.SetReadTimeout(d)
		c.set = d
	}
}

func (c *conn) setBaud(b int) error {
	if err := c.port.SetBaud(b); err != nil {
		return err
	}
	c.baud = b
	return nil
}

// fill appends what one read returns; false when it timed out.
func (c *conn) fill() (bool, error) {
	c.setTimeout(c.timeout)
	n, err := c.port.Read(c.tmp)
	if err != nil {
		return false, err
	}
	if n == 0 {
		return false, nil
	}
	c.buf = append(c.buf, c.tmp[:n]...)
	return true, nil
}

func (c *conn) take(k int) []byte {
	out := append([]byte(nil), c.buf[:k]...)
	c.buf = c.buf[k:]
	return out
}

func (c *conn) readN(n int) ([]byte, error) {
	deadline := c.clk.Now().Add(c.timeout)
	for len(c.buf) < n && c.clk.Now().Before(deadline) {
		ok, err := c.fill()
		if err != nil {
			return nil, err
		}
		if !ok {
			break
		}
	}
	return c.take(min(n, len(c.buf))), nil
}

func (c *conn) readByte() (byte, error) {
	b, err := c.readN(1)
	if err != nil || len(b) == 0 {
		return 0, err
	}
	return b[0], nil
}

// readUntil returns everything up to and including pat, or what arrived before the timeout.
func (c *conn) readUntil(pat []byte) ([]byte, error) {
	deadline := c.clk.Now().Add(c.timeout)
	for {
		if i := bytes.Index(c.buf, pat); i >= 0 {
			return c.take(i + len(pat)), nil
		}
		if !c.clk.Now().Before(deadline) {
			break
		}
		ok, err := c.fill()
		if err != nil {
			return nil, err
		}
		if !ok {
			break
		}
	}
	return c.take(len(c.buf)), nil
}

func (c *conn) drain() {
	c.buf = nil
	prev := c.timeout
	c.timeout = time.Millisecond
	for i := 0; i < 1000; i++ {
		if ok, err := c.fill(); err != nil || !ok {
			break
		}
		c.buf = nil
	}
	c.timeout = prev
}

func (c *conn) write(p []byte) error {
	_, err := c.port.Write(p)
	return err
}
