# GitWEd - Git-based website editor

Provide a git-backed WYSIWG website editing experience.

## GitLab FS

* periodically check SHA of master branch; when changes nuke all tree caches, but not blob caches
* get directory D:
  * `/projects/<id>/repository/tree?path=<D>`, cache at `<id>, <D>`
* get file F:
  * `/projects/<id>/repository/tree?path=<dirname(F)>`, cache at `<id>, dirname(F)`
  * `S := id(basename(F))`
  * `/projects/<id>/repository/raw_blobs/<S>`, cache at S

## Macro language

```html
<include src="header.html">
  <div id="foobar"> ... </div>
  <group id="blah"> Something </group>
</include>
```

### New tags

* `<include>` - include a file. Content of the tag indicates what to replace - matching is done by ID.
* `<group>` - all group tags are replaced with their content (they are invisible wrappers)
