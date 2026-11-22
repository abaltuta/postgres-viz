package analysis

import (
	"errors"
	"strings"

	pgquery "github.com/wasilibs/go-pgquery"
)

const (
	selectPrefix    = "SELECT "
	subscriptPrefix = selectPrefix + "(NULL)"
)

// The Go parser exposes PL/pgSQL assignment text but no assignment parse mode.
// Parse its RHS SELECT and optional target subscripts with the same byte offset.
func parseAssignment(sql string) (string, error) {
	scan, err := pgquery.Scan(sql)
	if err != nil {
		return "", err
	}
	firstBracket, depth := -1, 0
	var operatorStart, operatorEnd int
tokens:
	for _, tok := range scan.Tokens {
		start, end := int(tok.Start), int(tok.End)
		switch sql[start:end] {
		case "[":
			if firstBracket < 0 {
				firstBracket = start
			}
			depth++
		case "]":
			depth--
		case "=", ":=":
			if depth == 0 {
				operatorStart, operatorEnd = start, end
				break tokens
			}
		}
	}
	if operatorEnd == 0 {
		return "", errors.New("missing PL/pgSQL assignment operator")
	}
	pad := operatorEnd + len(subscriptPrefix) - len(selectPrefix)
	value, err := pgquery.ParseToJSON(selectPrefix + strings.Repeat(" ", pad) + sql[operatorEnd:])
	if err != nil {
		return "", err
	}
	if firstBracket < 0 {
		return "[" + value + "]", nil
	}
	// The variable and its fields are write targets. Only the indices
	// contain SQL expressions that can reference database objects.
	index, err := pgquery.ParseToJSON(subscriptPrefix + strings.Repeat(" ", firstBracket) + sql[firstBracket:operatorStart])
	if err != nil {
		return "", err
	}
	return "[" + value + "," + index + "]", nil
}

func (a *analyzer) assignment(sql string) error {
	tree, err := a.p.run(request{SQL: sql, Assignment: true})
	if err != nil {
		return err
	}
	parts := items(tree)
	if len(parts) == 2 {
		// PostgreSQL resolves the assignment indices against the RHS FROM.
		value := child(statements(parts[0])[0], "stmt", "SelectStmt")
		index := child(statements(parts[1])[0], "stmt", "SelectStmt")
		value["targetList"] = append(items(value["targetList"]), items(index["targetList"])...)
	}
	a.source(sql, -len(subscriptPrefix), true)
	a.query(parts[0])
	return nil
}
