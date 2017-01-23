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
* currently only a single `<id>` is supported

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


## Admin manual

### Adding users

You first need to log in as `admin` user.

To create user named `joe` go to `/gw/create/joe`. It generates a random password and hashes it.
It will return an authentication link like this:
`https://example.com/gw/auth?user=joe&pass=291c72c0471d44d7189e0cc356db46f4308ce4c3`

If the user already exists, you'll be given a chance to reset their password. You cannot reset admin 
password this way.

You can always append `&redirect=/foo/bar` to an authentication link.

Users are stored in `private/users.json` file. Passwords are strongly hashed, random, and very long,
so in principle this file can be world-readable.

To create first `admin` user, go to `/gw/hash/admin`, which just creates a random password, 
and copy `user` field into `users` array in `private/users.json`.


## TODO

* [x] authentication
* [ ] per-directory rights?
* [x] localization
* [ ] creation of new pages
* [x] add base file name to ids?
* [ ] extend the big "edit" button with custom actions (like 'add section')
* [ ] add language indication next to edit button
* [ ] add /gw/auth form with user/password (for password managers)
