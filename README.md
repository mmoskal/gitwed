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

