package analysis

import (
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"strings"

	pg "github.com/pganalyze/pg_query_go/v6"
	pgquery "github.com/wasilibs/go-pgquery"
)

var unknownField = regexp.MustCompile(`^"([^".]+)\.([^".]+)" is not a known variable$`)

// The standalone PL parser treats table%ROWTYPE as scalar without a server
// catalog. Locate the named variable in the outer block's DECLARE section.
func rowtypeDeclaration(body, variable string) (string, error) {
	scan, err := pgquery.Scan(body)
	if err != nil {
		return "", err
	}
	tokens := slices.DeleteFunc(scan.Tokens, func(t *pg.ScanToken) bool {
		return t.Token == pg.Token_SQL_COMMENT || t.Token == pg.Token_C_COMMENT
	})
	word := func(i int) string {
		if i >= len(tokens) {
			return ""
		}
		return body[tokens[i].Start:tokens[i].End]
	}
	declaring := false
	for i := range tokens {
		switch {
		case strings.EqualFold(word(i), "begin"):
			return "", errors.New("no matching row declaration")
		case !declaring && strings.EqualFold(word(i), "declare"):
			declaring = true
		case declaring && word(i) == ";":
		default:
			continue
		}
		if folded(word(i+1)) != variable {
			continue
		}
		start := i + 2
		if strings.EqualFold(word(start), "constant") {
			start++
		}
		end := start + 1
		schema, table := "", word(start)
		if word(end) == "." {
			schema, table = table, word(end+1)
			end += 2
		}
		if word(end) != "%" || !strings.EqualFold(word(end+1), "rowtype") {
			break
		}
		decl := map[string]any{
			"schema": schema, "table": table,
			"start": tokens[start].Start, "end": tokens[end+1].End,
			"line": 1 + strings.Count(body[:tokens[i+1].Start], "\n"),
		}
		raw, err := json.Marshal(decl)
		return string(raw), err
	}
	return "", errors.New("no matching row declaration")
}

func (a *analyzer) retryRowtype(parseErr error) (any, error) {
	field := unknownField.FindStringSubmatch(parseErr.Error())
	body := a.r.Body
	if field == nil || body == "" {
		return nil, parseErr
	}
	offset := strings.Index(a.r.Definition, body)
	if offset < 0 || offset != strings.LastIndex(a.r.Definition, body) {
		return nil, parseErr
	}
	raw, err := a.p.run(request{SQL: body, RowVariable: field[1]})
	if err != nil {
		return nil, parseErr
	}
	decl := obj(raw)
	schema, table := str(decl, "schema"), str(decl, "table")
	rel := a.rel(folded(table), folded(schema))
	if _, hits := a.base(rel).lookup(field[2]); hits != 1 {
		return nil, parseErr
	}
	start, end := num(decl, "start")+offset, num(decl, "end")+offset
	def := a.r.Definition
	replacement := "record" + strings.Repeat("\n", strings.Count(def[start:end], "\n"))
	tree, err := a.p.parse(def[:start]+replacement+def[end:], true)
	if err != nil {
		return nil, parseErr
	}
	f := child(items(tree)[0], "PLpgSQL_function")
	for _, v := range items(f["datums"]) {
		rec := child(v, "PLpgSQL_rec")
		if str(rec, "refname") == field[1] && num(rec, "lineno") == num(decl, "line") {
			if schema != "" {
				table = schema + "." + table
			}
			rec["datatype"] = node{"PLpgSQL_type": node{"typname": table + "%ROWTYPE"}}
			return tree, nil
		}
	}
	return nil, parseErr
}
