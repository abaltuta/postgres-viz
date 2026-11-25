package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/signal"
	"postgres-viz/internal/analysis"
	"postgres-viz/internal/catalog"
	"postgres-viz/internal/snapshot"
	"postgres-viz/internal/web"
	"strconv"
	"strings"
	"syscall"
)

//go:embed dist/viewer/index.html dist/viewer/main.js dist/viewer/style.css examples/commerce/commerce.pgviz.json
var assets embed.FS

const usage = `Usage:
  postgres-viz [POSTGRESQL_URI] [--no-browser]
  postgres-viz scan [POSTGRESQL_URI] --out FILE [--schema NAME ...] [--exclude-schema NAME ...] [--no-fks]
  postgres-viz open FILE [--no-browser]
  postgres-viz export-structure FILE --out FILE
  postgres-viz find --file FILE TERM
  postgres-viz refs --file FILE (--column SCHEMA.TABLE.COLUMN | --object LABEL) [--direction incoming|outgoing] [--depth 1|2] [--json]
  postgres-viz demo [--no-browser]

With a connection, capture the database and open the viewer. DATABASE_URL supplies
the connection when omitted. The viewer prints a loopback URL and serves until
interrupted. Use double quotes around case-sensitive SQL identifiers.`

type list []string

func (l *list) String() string     { return strings.Join(*l, ",") }
func (l *list) Set(v string) error { *l = append(*l, v); return nil }

// flag.FlagSet stops at the first positional. Collect positionals separately
// so both scan URI --out FILE and scan --out FILE URI are accepted.
func parse(set *flag.FlagSet, args []string) ([]string, error) {
	var options, positionals []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			positionals = append(positionals, args[i+1:]...)
			break
		}
		if arg == "--help" || arg == "-h" {
			return nil, flag.ErrHelp
		}
		if arg == "-" || !strings.HasPrefix(arg, "-") {
			positionals = append(positionals, arg)
			continue
		}
		key, _, assigned := strings.Cut(strings.TrimLeft(arg, "-"), "=")
		f := set.Lookup(key)
		if f == nil {
			return nil, errors.New("unknown option; see --help")
		}
		options = append(options, arg)
		if _, boolean := f.Value.(interface{ IsBoolFlag() bool }); !boolean && !assigned {
			i++
			if i >= len(args) {
				return nil, fmt.Errorf("--%s requires a value", key)
			}
			options = append(options, args[i])
		}
	}
	if err := set.Parse(options); err != nil {
		return nil, errors.New("invalid option value; see --help")
	}
	return positionals, nil
}
func run(ctx context.Context, args []string, out, errOut io.Writer) error {
	command := "view"
	if len(args) > 0 {
		switch args[0] {
		case "help":
			fmt.Fprintln(out, usage)
			return nil
		case "__parser":
			return analysis.Worker()
		case "scan", "open", "export-structure", "find", "refs", "demo":
			command, args = args[0], args[1:]
		}
	}
	set := flag.NewFlagSet(command, flag.ContinueOnError)
	set.SetOutput(io.Discard)
	var noBrowser, noFK, asJSON bool
	var include, exclude list
	var output, file, column, object, depth, direction string
	if command == "demo" || command == "open" || command == "view" {
		set.BoolVar(&noBrowser, "no-browser", false, "")
	}
	if command == "scan" || command == "view" {
		set.Var(&include, "schema", "")
		set.Var(&exclude, "exclude-schema", "")
		set.BoolVar(&noFK, "no-fks", false, "")
	}
	if command == "scan" || command == "export-structure" {
		set.StringVar(&output, "out", "", "")
	}
	if command == "refs" || command == "find" {
		set.StringVar(&file, "file", "", "")
	}
	if command == "refs" {
		set.StringVar(&column, "column", "", "")
		set.StringVar(&object, "object", "", "")
		set.StringVar(&depth, "depth", "2", "")
		set.StringVar(&direction, "direction", "incoming", "")
		set.BoolVar(&asJSON, "json", false, "")
	}
	pos, err := parse(set, args)
	if errors.Is(err, flag.ErrHelp) {
		fmt.Fprintln(out, usage)
		return nil
	}
	if err != nil {
		return err
	}
	var data []byte
	switch command {
	case "demo":
		if len(pos) > 0 {
			return errors.New("demo takes no positional arguments")
		}
		data, err = assets.ReadFile("examples/commerce/commerce.pgviz.json")
	case "open", "export-structure", "refs", "find":
		switch command {
		case "find":
			if file == "" || len(pos) != 1 || pos[0] == "" {
				return errors.New("find requires --file and one non-empty search term")
			}
		case "open", "export-structure":
			if len(pos) != 1 {
				return fmt.Errorf("%s expects one snapshot file", command)
			}
			file = pos[0]
			if command == "export-structure" && output == "" {
				return errors.New("export-structure requires --out FILE")
			}
		case "refs":
			var selectors int
			set.Visit(func(f *flag.Flag) {
				if f.Name == "column" || f.Name == "object" {
					selectors++
				}
			})
			if len(pos) != 0 || file == "" || selectors != 1 || (column == "" && object == "") {
				return errors.New("refs requires --file and exactly one of --column or --object")
			}
		}
		data, err = os.ReadFile(file)
		if err != nil {
			return err
		}
		s, err := snapshot.Read(data)
		if err != nil {
			return err
		}
		if command == "find" {
			matches := s.Find(pos[0])
			if len(matches) == 0 {
				fmt.Fprintln(out, "No matching objects or columns.")
			}
			for _, match := range matches {
				fmt.Fprintf(out, "%s\t%s\n", match.Kind, match.Selector)
			}
			return nil
		}
		if command == "export-structure" {
			source, err := os.Stat(file)
			if err != nil {
				return err
			}
			dest, err := os.Stat(output)
			if err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			if os.SameFile(source, dest) {
				return errors.New("choose a different output file to preserve the original snapshot")
			}
			if err := snapshot.Write(ctx, output, s.Structure()); err != nil {
				return err
			}
			fmt.Fprintln(errOut, "Saved", output)
			return nil
		}
		if command == "refs" {
			d, _ := strconv.Atoi(depth)
			refs, err := s.QueryReferences(snapshot.ReferenceQuery{Column: column, Object: object, Depth: d, Direction: direction})
			if err != nil {
				return err
			}
			if asJSON {
				return json.NewEncoder(out).Encode(refs)
			}
			refs.Print(out)
			return nil
		}
	case "view", "scan":
		if len(pos) > 1 {
			return errors.New("expected a single PostgreSQL URI")
		}
		conn := os.Getenv("DATABASE_URL")
		if len(pos) == 1 {
			conn = pos[0]
		}
		if conn == "" {
			return errors.New("provide a PostgreSQL URI or set DATABASE_URL; see --help")
		}
		if !strings.HasPrefix(conn, "postgresql://") && !strings.HasPrefix(conn, "postgres://") {
			return errors.New("expected a postgresql:// or postgres:// connection URI")
		}
		if command == "scan" && output == "" {
			return errors.New("scan requires --out FILE")
		}
		s, routines, err := catalog.Capture(ctx, conn, include, exclude, !noFK)
		if err != nil {
			return err
		}
		if err = analysis.Analyze(ctx, s, routines); err != nil {
			return err
		}
		s.CompleteEvidence()
		if err = s.Validate(); err != nil {
			return err
		}
		for _, warning := range s.Diagnostics.Warnings {
			fmt.Fprintln(errOut, warning)
		}
		if command == "scan" {
			if err = snapshot.Write(ctx, output, s); err != nil {
				return err
			}
			fmt.Fprintln(errOut, "Saved", output)
			return nil
		}
		data, err = json.Marshal(s)
		if err != nil {
			return err
		}
	}
	if err != nil {
		return err
	}
	ui, err := fs.Sub(assets, "dist/viewer")
	if err != nil {
		return err
	}
	return web.Serve(ctx, ui, data, !noBrowser, out, errOut)
}
func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:], os.Stdout, os.Stderr); err != nil {
		if ctx.Err() != nil {
			fmt.Fprintln(os.Stderr, "postgres-viz: interrupted")
			os.Exit(130)
		}
		fmt.Fprintln(os.Stderr, "postgres-viz:", err)
		os.Exit(1)
	}
}
