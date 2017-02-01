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
* in fact, there is no need to worry about `config.json` at all

## CDN rewriting

GitWEd will generally try to rewrite your URLs so that they can be served from a CDN
(Content Delivery Network). It always rewrites the following:

* `<img src="...">`
* `<audio>`, `<video>`, `<track>`
* various `<meta ...>` and `<link ...>` tags that point to images

In the following tags, it will also rewrite links to files that are images,
or live in `cdn` sub-directory of your page, or in `/common` directory.

* `<script src="...">`
* `<link rel="stylesheet" href="...">`
* `@import` in inline CSS
* `url()` in inline CSS

Note that rewriting occurs **only in HTML**. GitWED does not rewrite your CSS or JS
files.

In general, it's good to put files in `cdn` subdirectory, as it greatly speeds up
page load. However, you cannot put there CSS files that have embedded relative `url()`
or `@import`. You can always consider lifting CSS rules with relative URLs into
an inline CSS where there will be rewritten.

You will most likely want to test this feature before deploying. To do so, make sure
all your files are checked in (but not necessarily pushed) in `gitwed-data` and
then run `make cdn`. The URLs will be rewritten to paths like
`/cdn/img_3834.jpg-b6d3e026697ae54d8749c13167b44239e1409c9b.jpg`.
When deployed, it will be something like:
`https://dwb.azureedge.net/img_3834.jpg-b6d3e026697ae54d8749c13167b44239e1409c9b.jpg`.


## Macro language

```html
<include src="header.html">
  <div id="foobar"> ... </div>
  <group id="blah"> Something </group>
</include>
```

### New tags

* `<include>` - include a file. Content of the tag indicates what to replace - matching is done by ID;
  you can also have `<include src="..." />` if you don't want to replace anything
* `<group>` - all group tags are replaced with their content (they are invisible wrappers)
* `<if-edit>` - the tag, along with its children, is removed unless the user has edit permission

### Marking elements for editing

You need to add `edit` attribute. You will also need a unique (in file) identifier
for the element. This can be specified with `id` or as argument to `edit`. Example:

```
<div class='foobar' edit=desc1>
<p> ... </p>
</div>

<div class='barbaz' edit id=desc2>
<h1> ... </h1>
<p> ... </p>
</div>

<li><a href="qux" class="..." edit="link-qux">Some text</a></li>
```

In the tag marked with `edit` has at least one of the following as children:
`p, ul, ol, h1, h2, h3, h4, h5, h6` the full HTML editor will be used.
If it doesn't, only the text can be edited.

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
* [x] make sure no /gw/* files are required when not editing
* [ ] issue HTTPS redirects
* [ ] image upload has issues?
* [ ] push (and pull?) in background
* [ ] add `/gw/refresh` endpoint

### Deployment

* [ ] auto-restart upon crash
* [ ] auto-restart every 2h or so
* [ ] disable clean-repo check
* [ ] log output to file

### Further down

* [ ] add lang from web?
* [ ] extend the big "edit" button with custom actions (like 'add section')
* [ ] history restore
* [ ] add HSTS
