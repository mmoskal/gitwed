# GitWEd - Git-based website editor

Provides a git-backed WYSIWG website editing experience.

## What does it do?

GitWEd is a application running in node.js in the cloud, which serves websites
from a git repo of your choosing. The website developer can update the HTML/CSS/image/... files
in this repo as usual. Content editors can authorize using their email
address, and then update the specially marked fragments of HTML
using [ContentTools](http://getcontenttools.com/), a WYSIWG editor.
The changes are saved to the git repo.

## How does it work?

GitWEd is written in TypeScript, compiled down to JavaScript and running on the
server using node.js and on the client in the browser. GitWEd serves plain
files from a git repo (called data repo, as it doesn't have GitWEd sources,
just the websites to be served).  The server also handles AJAX POST requests
from authorized users, which update the HTML and check in the new version into
the data repo. These POSTs update specifically marked fragments of HTML
(ones with `edit=...` attribute).

Resource files (images, JavaScript, CSS, etc.) are served exactly as is.  HTML files
are parsed, and the server expands a few additional tags, things like
`<include src="_footer.html">`; it isn't necessary to use these additional tags,
so you can just write plain HTML if you feel like it.
Additionally, references to resources in the HTML files are optionally
rewritten to use browser-cachable URLs on a CDN.

## Running locally

* checkout https://gitlab.dwbn.org/mmoskal/gitwed-data
* go there and run
```
npm install
npm start
```
* this will run a server on http://localhost:3000, serving the current directory
* if you modify files via web interface, they will be modified in the current directory
* if you modify files in the current directory, the changes should be visible at http://localhost:3000
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
`https://dwbe.azureedge.net/img_3834.jpg-b6d3e026697ae54d8749c13167b44239e1409c9b.jpg`.


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

```html
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

## User manual

* there is no auto-save - you need to click the green accept button; you can also use the red reject
  button to discard changes (the browser will warn you)
* currently, copy-paste only works for text
* you can drag paragraphs around - click **and hold for a second**, then drag
* you can also drag some images, by just clicking and dragging
* when editing, especially translating, links (or other formatted content like headings), 
  to avoid losing formatting position the cursor in the middle of the link, type the new
  text for the link, and then remove the bits you don't need; eg. if you have link that
  says `Home`, then move cursor say between `H` and `ome`, type `Strona Domowa`, getting
  `HStrona Domowaome` and remove the `H` and `ome`
* there's a bottom **editor section** of the page, usually on blue background, which is visible only
  to editors; it lets you edit things like the title of the page that shows on the browser
  window bar, or description and keywords used by search engines
* you can replace images by clicking on the `Edit images` in the editor section; this replaces
  existing images and once your confirm you cannot undo easily (short of uploading the old
  picture again)
* you can insert new images in free-flow text sections by clicking the "Image" button;
  then click `Upload` (and wait a few seconds if nothing shows up); after selecting
  your image, click `Upload` again
* you can invite new people to edit by clicking on the orange `...` button and entering their
  email
* you can also view historic versions of the page from the `...` button
* if you do not see the pencil or orange `...` button, try adding `/edit` to the website address;
  for example if the address is `https://example.com/foo` then enter `https://example.com/foo/edit`,
  and if the address is `https://example.com/` enter `https://example.com/edit`;
  also, if the address has `#` in it, remove the `#` and everything after it, for example
  `https://example.com/#s=something` becomes `https://example.com/edit`
* to add a new sub-page, first add a link to it - write the link text (eg. `Sleeping hall`),
  select it, click the "chain-link" button, and enter link, for example `accomodation`;
  save and follow the link; on the not `Not found` page, click the link `Create page`
  (note to developers - this will clone `_new.html` file)

## TODO
* [x] push (and pull?) in background
* [x] add `/api/refresh` endpoint
* [ ] add `gw-copy-from=<ID>` attribute
* [x] handle lack of `/index`
* [x] add vhost support

### Deployment
* [ ] auto-restart upon crash?
* [x] auto-restart every 2h or so
* [x] disable clean-repo check
* [x] log output to file

### Further down
* [ ] specify custom styles in per-page `config.json`; same for `data-background` etc
* [ ] creation of new pages
* [ ] add lang from web?
* [ ] extend the big "edit" button with custom actions (like 'add section')
* [ ] history restore
* [x] add cache of expanded pages (based on HEAD rev)
* [ ] extend /api/logs with file system access
