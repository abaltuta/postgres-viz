package catalog

import (
	"cmp"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"postgres-viz/internal/snapshot"
)

//go:embed catalog.sql
var catalogSQL string

func schemaNames(names []string) []string {
	seen := make(map[string]bool, len(names))
	var result []string
	for _, name := range names {
		if name != "" && !seen[name] {
			result = append(result, name)
			seen[name] = true
		}
	}
	return result
}

// pgx's connection and configuration errors may contain the original DSN.
func stageError(ctx context.Context, stage string, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return fmt.Errorf("%s: PostgreSQL error %s (%s)", stage, pgErr.Code, pgErr.Severity)
	}
	return errors.New(stage)
}

func Capture(ctx context.Context, conn string, include, exclude []string, includeFK bool) (*snapshot.Snapshot, []snapshot.Routine, error) {
	db, err := pgx.Connect(ctx, conn)
	if err != nil {
		return nil, nil, stageError(ctx, "cannot connect to PostgreSQL; check DATABASE_URL and server availability", err)
	}
	defer db.Close(context.Background())
	tx, err := db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, nil, stageError(ctx, "cannot start catalog snapshot", err)
	}
	defer tx.Rollback(context.Background())
	var database string
	var version int
	if err = tx.QueryRow(ctx, "SELECT current_database(),current_setting('server_version_num')::int").Scan(&database, &version); err != nil {
		return nil, nil, stageError(ctx, "cannot read database metadata", err)
	}

	include = schemaNames(include)
	exclude = schemaNames(exclude)
	if len(include) > 0 || exclude == nil {
		exclude = []string{}
	}
	s := snapshot.New(database, include, exclude)
	hasBody := "false"
	if version >= 140000 {
		hasBody = "p.prosqlbody IS NOT NULL"
	}
	rows, err := tx.Query(ctx, strings.ReplaceAll(catalogSQL, "/*HAS_SQL_BODY*/", hasBody), include, exclude, includeFK)
	if err != nil {
		return nil, nil, stageError(ctx, "cannot query PostgreSQL catalogs", err)
	}
	var category string
	var data []byte
	var routines []snapshot.Routine
	_, err = pgx.ForEachRow(rows, []any{&category, &data}, func() error {
		switch category {
		case "object":
			var row struct {
				snapshot.Object
				SQL string
			}
			if err := json.Unmarshal(data, &row); err != nil {
				return err
			}
			s.Objects = append(s.Objects, row.Object)
			if row.SQL != "" {
				s.Definitions = append(s.Definitions, snapshot.Definition{OwnerID: row.ID, SQL: row.SQL})
			}
		case "column":
			var c snapshot.Column
			if err := json.Unmarshal(data, &c); err != nil {
				return err
			}
			s.Columns = append(s.Columns, c)
		case "routine":
			var row struct {
				snapshot.Routine
				Kind                     string
				InputCount, DefaultCount int
				ArgNames, ArgModes       []string
			}
			if err := json.Unmarshal(data, &row); err != nil {
				return err
			}
			kind, detail := "function", row.Language+" returns "+row.Returns
			if row.Kind == "p" {
				kind, detail = "procedure", row.Language
			}
			s.Objects = append(s.Objects, snapshot.Object{ID: row.ID, Schema: row.Schema, Name: row.Name + "(" + row.Args + ")", Kind: kind, Detail: detail})
			row.Routine.ServerVersion = version
			row.Routine.CallParameters = callParameters(row.Kind, row.InputCount, row.DefaultCount, row.ArgNames, row.ArgModes)
			routines = append(routines, row.Routine)
			if sql := cmp.Or(row.Definition, row.Body); sql != "" {
				s.Definitions = append(s.Definitions, snapshot.Definition{OwnerID: row.ID, SQL: sql})
			}
		case "edge":
			var edge snapshot.Relationship
			if err := json.Unmarshal(data, &edge); err != nil {
				return err
			}
			s.Relationships = append(s.Relationships, edge)
		default:
			return fmt.Errorf("unexpected catalog record %q", category)
		}
		return nil
	})
	if err != nil {
		return nil, nil, stageError(ctx, "cannot read catalog snapshot", err)
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, nil, stageError(ctx, "cannot complete catalog snapshot", err)
	}
	slices.SortFunc(s.Objects, func(a, b snapshot.Object) int { return cmp.Compare(a.ID, b.ID) })
	slices.SortFunc(s.Columns, func(a, b snapshot.Column) int {
		return cmp.Or(cmp.Compare(a.ObjectID, b.ObjectID), cmp.Compare(a.Position, b.Position))
	})
	slices.SortFunc(s.Relationships, func(a, b snapshot.Relationship) int {
		return cmp.Or(cmp.Compare(cmp.Or(a.ConstraintID, a.ID), cmp.Or(b.ConstraintID, b.ID)), cmp.Compare(a.Position, b.Position))
	})
	slices.SortFunc(s.Definitions, func(a, b snapshot.Definition) int { return cmp.Compare(a.OwnerID, b.OwnerID) })
	slices.SortFunc(routines, func(a, b snapshot.Routine) int { return cmp.Compare(a.ID, b.ID) })
	return s, routines, nil
}

func callParameters(kind string, inputs, defaults int, names, modes []string) []snapshot.CallParameter {
	params := make([]snapshot.CallParameter, 0, inputs)
	seenInputs := 0
	for i := range max(inputs, len(modes)) {
		mode := "i"
		if len(modes) > 0 {
			mode = modes[i]
		}
		input := mode != "o" && mode != "t"
		if input {
			seenInputs++
		} else if kind != "p" {
			continue
		}
		p := snapshot.CallParameter{Defaulted: input && seenInputs > inputs-defaults, Variadic: mode == "v"}
		if len(names) > 0 {
			p.Name = names[i]
		}
		params = append(params, p)
	}
	return params
}
