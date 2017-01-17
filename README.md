# GitWEd - Git-based website editor

Provide a git-backed WYSIWG website editing experience.

## Running locally

* checkout https://gitlab.dwbn.org/mmoskal/gitwed into `somewhere/gitwed`
* checkout https://gitlab.dwbn.org/mmoskal/gitwed-data into `somewhere/gitwed-data`
* go to `somewhere/gitwed`, run:
```
npm install
make
```
* this will run a server on http://localhost:3000, serving from `somewhere/gitwed-data`
* if you modify files via web interface, they will be modified in `somewhere/gitwed-data`
* if you modify files in `somewhere/gitwed-data`, the changes should be visible at http://localhost:3000

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
