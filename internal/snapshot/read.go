package snapshot

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"strings"
	"unicode/utf8"
)

func decodeSnapshot(data []byte, s *Snapshot) error {
	if !utf8.Valid(data) {
		return errors.New("invalid snapshot JSON: expected UTF-8")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var root map[string]any
	if err := decoder.Decode(&root); err != nil {
		return fmt.Errorf("invalid snapshot JSON: %w", err)
	}
	if len(bytes.Trim(data[decoder.InputOffset():], " \t\r\n")) != 0 {
		return errors.New("invalid snapshot JSON: trailing data")
	}
	if format, _ := root["format"].(string); format == "" && root["graph"] != nil {
		return errors.New("legacy graph-only export lacks SQL evidence; scan again")
	}
	if err := decodeValue(root, reflect.ValueOf(s).Elem()); err != nil {
		return fmt.Errorf("invalid snapshot: %w", err)
	}
	return nil
}

// Read the exact JSON names from the wire types. A typed json.Unmarshal
// would match keys case-insensitively and discard the distinction between
// a missing field, null, and a valid zero value.
func decodeValue(src any, dst reflect.Value) error {
	switch dst.Kind() {
	case reflect.Struct:
		obj, ok := src.(map[string]any)
		if !ok {
			return errors.New("expected an object")
		}
		for i := range dst.NumField() {
			field := dst.Type().Field(i)
			name, option, _ := strings.Cut(field.Tag.Get("json"), ",")
			value, exists := obj[name]
			if !exists {
				if option == "omitempty" {
					continue
				}
				return fmt.Errorf("missing %s", name)
			}
			switch field.Tag.Get("snapshot") {
			case "nullable":
				if value == nil {
					continue
				}
			case "nonempty":
				if value == "" {
					return fmt.Errorf("empty %s", name)
				}
			}
			if err := decodeValue(value, dst.Field(i)); err != nil {
				return fmt.Errorf("%s: %w", name, err)
			}
		}
	case reflect.Slice:
		items, ok := src.([]any)
		if !ok {
			return errors.New("expected an array")
		}
		dst.Set(reflect.MakeSlice(dst.Type(), len(items), len(items)))
		for i, item := range items {
			if err := decodeValue(item, dst.Index(i)); err != nil {
				return fmt.Errorf("item %d: %w", i, err)
			}
		}
	case reflect.String:
		value, ok := src.(string)
		if !ok {
			return errors.New("expected a string")
		}
		dst.SetString(value)
	case reflect.Int:
		number, ok := src.(json.Number)
		if !ok {
			return errors.New("expected an integer")
		}
		// Use the same numeric representation and safe-integer bounds as Prism.
		value, err := number.Float64()
		if err != nil || math.Abs(value) > maxSafeInteger || math.Trunc(value) != value || dst.OverflowInt(int64(value)) {
			return errors.New("expected a safe integer")
		}
		dst.SetInt(int64(value))
	case reflect.Pointer:
		dst.Set(reflect.New(dst.Type().Elem()))
		return decodeValue(src, dst.Elem())
	default:
		return fmt.Errorf("unsupported snapshot type %s", dst.Type())
	}
	return nil
}
