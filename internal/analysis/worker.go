package analysis

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"time"

	pgquery "github.com/wasilibs/go-pgquery"
)

type request struct {
	Version     int
	PL          bool
	Assignment  bool
	RowVariable string
	SQL         string
}
type response struct {
	Tree  json.RawMessage
	Error string
}

// Worker serves parse requests until its parent's stdin closes.
func Worker() error {
	in, out := json.NewDecoder(os.Stdin), json.NewEncoder(os.Stdout)
	for {
		var req request
		if err := in.Decode(&req); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		var raw string
		var err error
		if req.RowVariable != "" {
			raw, err = rowtypeDeclaration(req.SQL, req.RowVariable)
		} else if req.Assignment {
			raw, err = parseAssignment(req.SQL)
		} else if req.PL {
			raw, err = pgquery.ParsePlPgSqlToJSON(req.SQL)
			if err != nil && supports(req.Version, 18) {
				raw, err = modernPL(req.SQL, req.Version, err)
			}
		} else {
			raw, err = pgquery.ParseToJSON(req.SQL)
			if err != nil && supports(req.Version, 18) {
				raw, err = modernSQL(req.SQL, req.Version, err)
			}
		}
		var res response
		if err != nil {
			res.Error = err.Error()
		} else {
			res.Tree = json.RawMessage(raw)
		}
		if err := out.Encode(res); err != nil {
			return err
		}
	}
}

type parser struct {
	ctx     context.Context
	cmd     *exec.Cmd
	in      io.WriteCloser
	enc     *json.Encoder
	dec     *json.Decoder
	count   int
	version int
}

func (p *parser) start() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(p.ctx, exe, "__parser")
	in, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		in.Close()
		return err
	}
	if err := cmd.Start(); err != nil {
		in.Close()
		out.Close()
		return err
	}
	p.cmd, p.in, p.enc, p.dec = cmd, in, json.NewEncoder(in), json.NewDecoder(out)
	p.count = 0
	// Compiling the embedded parser is a one-time startup cost. Give that
	// fixed input its own deadline so the per-user-query limit stays strict.
	_, err = p.exchange(request{SQL: "SELECT 1"}, 30*time.Second)
	return err
}

func (p *parser) close() {
	if p.cmd == nil {
		return
	}
	p.in.Close()
	_ = p.cmd.Process.Kill()
	_ = p.cmd.Wait()
	p.cmd = nil
}

func (p *parser) parse(sql string, pl bool) (any, error) {
	return p.run(request{SQL: sql, PL: pl})
}

func (p *parser) run(req request) (any, error) {
	req.Version = p.version
	if err := p.ctx.Err(); err != nil {
		return nil, err
	}
	if p.count >= 500 {
		p.close()
	}
	if p.cmd == nil {
		if err := p.start(); err != nil {
			return nil, err
		}
	}
	p.count++
	return p.exchange(req, 5*time.Second)
}

func (p *parser) exchange(req request, deadline time.Duration) (any, error) {
	var res response
	done := make(chan error, 1)
	go func() {
		if err := p.enc.Encode(req); err != nil {
			done <- err
			return
		}
		done <- p.dec.Decode(&res)
	}()
	timer := time.NewTimer(deadline)
	defer timer.Stop()
	select {
	case err := <-done:
		if err != nil {
			p.close()
			return nil, err
		}
	case <-timer.C:
		p.close()
		<-done
		return nil, fmt.Errorf("PostgreSQL parser timed out")
	case <-p.ctx.Done():
		p.close()
		<-done
		return nil, p.ctx.Err()
	}
	if res.Error != "" {
		return nil, errors.New(res.Error)
	}
	var tree any
	err := json.Unmarshal(res.Tree, &tree)
	return tree, err
}
