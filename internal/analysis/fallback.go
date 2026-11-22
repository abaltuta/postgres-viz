package analysis

import (
	"regexp"
	"slices"
	"strings"
)

var maskTokens = regexp.MustCompile(`--[^\n]*|/\*|(?:\b[Ee])?'|\$(?:[a-zA-Z_]\w*)?\$|` + ident)

// maskSQL removes comments and literals from lexical analysis while retaining
// identifiers. Consuming them whole keeps dollar signs within a name from
// opening a dollar-quoted literal. PostgreSQL block comments can nest.
func maskSQL(sql string) string {
	var out strings.Builder
	for len(sql) > 0 {
		m := maskTokens.FindStringIndex(sql)
		if m == nil {
			out.WriteString(sql)
			break
		}
		start, end := m[0], m[1]
		out.WriteString(sql[:start])
		tok := sql[start:end]
		switch {
		case strings.HasPrefix(tok, "--"):
		case tok == "/*":
			depth := 1
			for depth > 0 && end < len(sql) {
				switch {
				case strings.HasPrefix(sql[end:], "/*"):
					depth++
					end += 2
				case strings.HasPrefix(sql[end:], "*/"):
					depth--
					end += 2
				default:
					end++
				}
			}
		case strings.HasSuffix(tok, "'"):
			for end < len(sql) {
				c := sql[end]
				end++
				if len(tok) > 1 && c == '\\' && end < len(sql) {
					end++
					continue
				}
				if c == '\'' {
					if end < len(sql) && sql[end] == '\'' {
						end++
						continue
					}
					break
				}
			}
		case tok[0] == '$':
			if close := strings.Index(sql[end:], tok); close >= 0 {
				end += close + len(tok)
			} else {
				end = len(sql)
			}
		default:
			out.WriteString(tok)
			sql = sql[end:]
			continue
		}
		out.WriteByte(' ')
		sql = sql[end:]
	}
	return out.String()
}

var fallbackTokens = regexp.MustCompile(ident + `|\S`)
var fallbackIdentifier = regexp.MustCompile(`^` + ident + `$`)

func fallbackRelationKind(before []string) string {
	if last(before) == "only" {
		before = before[:len(before)-1]
	}
	endsWith := func(words ...string) bool {
		return len(before) >= len(words) && slices.Equal(before[len(before)-len(words):], words)
	}
	switch {
	case endsWith("insert", "into"):
		return "inserts"
	case endsWith("update"):
		return "updates"
	case endsWith("delete", "from"), endsWith("truncate"), endsWith("truncate", "table"):
		return "deletes"
	case endsWith("merge", "into"):
		return "writes"
	case endsWith("is", "distinct", "from"), endsWith("is", "not", "distinct", "from"):
		return ""
	case endsWith("from"), endsWith("join"):
		return "reads"
	}
	return ""
}

func (a *analyzer) fallback() {
	tokens := fallbackTokens.FindAllString(maskSQL(a.r.Body), -1)
	for i, tok := range tokens {
		if tok[0] != '"' {
			tokens[i] = strings.ToLower(tok)
		}
	}
	for i := 0; i < len(tokens); i++ {
		if tokens[i] == "only" || tokens[i] == "table" || !fallbackIdentifier.MatchString(tokens[i]) {
			continue
		}
		kind := fallbackRelationKind(tokens[:i])
		parts := []string{folded(tokens[i])}
		if i+2 < len(tokens) && tokens[i+1] == "." && fallbackIdentifier.MatchString(tokens[i+2]) {
			i += 2
			parts = append(parts, folded(tokens[i]))
		}
		if kind != "" {
			if ids := a.matches(a.relations, parts); len(ids) == 1 {
				a.addEdge(kind, ids[0], "fallback")
			}
		}
		if (kind == "" || kind == "reads") && i+1 < len(tokens) && tokens[i+1] == "(" {
			a.recordCall(parts, a.matches(a.functions, parts), "fallback")
		}
	}
}
