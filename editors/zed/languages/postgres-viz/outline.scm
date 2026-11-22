(document
  (object
    (pair
      key: (string (string_content) @name)
      value: [(array) (object)]) @item))

(object
  (pair
    key: (string (string_content) @_key)
    value: (string (string_content) @name))
  (#eq? @_key "name")) @item
