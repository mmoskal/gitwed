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
* there is no need to worry about user accounts unless you add `jwtSecret` to `config.json` - everyone connecting will be treated as an admin

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

You can invite new users from the "..." menu. The invitation is only valid for one subdirectory.
If you want the user to have write access everywhere, make them an admin.

You can always append `&redirect=/foo/bar` to an authentication link.

Users are stored in `private/users.json` file. 

## TODO

* [x] set user doing commit
* [ ] creation of new pages
* [x] nicer 404
* [x] sort out image centering when not in edit mode
* [x] redirect to index
* [x] language switcher
* [ ] title+meta editing
* [ ] make sure no /gw/* files are required when not editing

## Further down TODO

* [ ] add lang from web?
* [ ] extend the big "edit" button with custom actions (like 'add section')
* [ ] history restore
* [ ] add HSTS
