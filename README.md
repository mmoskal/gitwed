# GitWEd - Git-based website editor

Provides a git-backed WYSIWG website editing experience.

## What does it do?

GitWEd is a application running in node.js in the cloud, which serves websites
from a git repo of your choosing. The website developer can update the HTML/CSS/image/... files
in this repo as usual. Content editors can authorize using their email
address, and then update the specially marked fragments of HTML
using [ContentTools](http://getcontenttools.com/), a WYSIWG editor.
The changes are saved to the git repo.

See https://dwbe.org/manual/ for user manual.

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

* checkout https://github.com/mmoskal/gitwed-sample
  (or https://gitlab.dwbn.org/mmoskal/gitwed-data if you have access)
* go there and run
```
npm install
npm start
```
* this will run a server on http://localhost:3000, serving the current directory
* if you modify files via web interface, they will be modified in the current directory
* if you modify files in the current directory, the changes should be visible at http://localhost:3000
* there is no need to worry about user accounts unless you add `jwtSecret` 
  to `config.json` - everyone connecting will be treated as an admin
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
`/cdn/img_3834.jpg-2c66e904cab0c00d52a924214880179da395f587.jpg`.
When deployed, it will be something like:
`https://mycdn.somewhere.net/img_3834.jpg-2c66e904cab0c00d52a924214880179da395f587.jpg`.


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

This section is only relevant if you want to run your own Gitwed server.

You can invite new users from the "..." menu. The invitation is only valid for one subdirectory.
If you want the user to have write access everywhere, make them an admin.

You can always append `&redirect=/foo/bar` to an authentication link.

Users are stored in `private/users.json` file.

Example config (remove ``// comments` when you create your own):

```javascript
{
    // this is used as signing key for cookies - just generate a long "password" here
    "jwtSecret": "<generate a ~30 character random string here>",
    // this you can get from mailgun dashboard
    "mailgunApiKey": "key-0123456789...abcdef",
    // in both cases (mailgun and sendgrid) default email sender is set to `no-reply@config.mailgunDomain`
    "mailgunDomain": "mg.example.com",
    // this is your sendGrid Api KEY - you can get one from https://sendgrid.com/docs/ui/account-and-settings/api-keys/
    // Gitwed uses sendgrid `only` if no mailgunApiKey was provided
    "sendgridApiKey": "SG.XXXXX-...abcdf"
    // list of email recipients that gitwed is allowed to send emails to on `/api/send-email`
    "allowedEmailRecipients" : ["me@example.com"],
    // if you want to generate map images in events, you need a key for Google Maps
    "gmapsKey": "ABcDe...FgHg",
    // this is used in subject line of emails
    "serviceName": "DWB-Edit",
    // default redirect path
    "defaultRedirect": "sample",
    // you can set that option to 127.0.0.1 or 0.0.0.0, the default value is localhost
    "networkInterface": "localhost",
    // one of your domains; authentication is always handled through that one
    "authDomain": "https://example.com",
    // if set to true, request a separate Let's Encrypt certificate for each configured hostname;
    // names whose DNS is not ready stay pending and are checked again automatically
    "production": true,
    // email to use for Let's Encrypt
    "certEmail": "me@example.com",
    // optional: use untrusted staging certificates and separate account/certificate storage
    "certStaging": false,
    // if set to true, it will listen on ${config.localhost}:3000 and listen to proxy requests from nginx or apache
    // otherwise, run standalone
    "proxy": false,
    // this CDN endpoint needs to be set to mirror /cdn path on the server; this will usually be either
    // "https://cdn.example.com" or "https://cdn.example.com/cdn", depending how you set it up
    // set to "/cdn" if you don't have a separate CDN
    "cdnPath": "https://cdn.example.com",
    // relative path to the main content repo
    "repoPath": "../gitwed-data",
    // relative path to additional content repos; the format is "short-key": "path"
    // the short-key will be used in URLs
    "sideRepos": {
      "home": "../gitwed-homepage",
      "foo": "../../other/foo-bar"
    },
    // relative path to repo hosting data about events
    "eventsRepoPath": "../gitwed-events",
    // virtual hosts; Let's Encrypt will be asked for certs of all of these and the authDomain
    // the format is: "virtual.host.name": "directory"
    // the directory can be in main or any of the side repos
    "vhosts": {
       "course.example.com": "course2018",
       // you may want to set directory name and host name the same, but it's not required
       "something.foobar.net": "something.foobar.net",
       // an empty directory means "/"; used to force certificate generation for that host 
       "hosting.example.com": ""
    }
}
```

### Automatic certificates

In standalone production mode, Gitwed maintains one certificate per hostname in
`authDomain`, `vhosts`, and `vhostRedirs`. `example.com` and `www.example.com` are
independent names; no aliases are added automatically. All certificates share one
ACME account and are selected through SNI on the same HTTPS listener.

After restarting to load a configuration change, new names may remain pending
until their DNS is ready. Before requesting a certificate, Gitwed fetches a random
token from that hostname over HTTP on port 80. A failed probe is retried every
30 minutes without opening an ACME order. The probe requires a direct response
from Gitwed's challenge route and does not follow redirects.

A background scan runs every minute. Renewal follows a random time in Let's
Encrypt's ARI window, refreshed every six hours. When ARI is unavailable for a new
certificate, renewal is scheduled at 60% of its actual validity period, with
5% jitter on that delay (57–63% of validity). These times survive restarts.

Issuance and renewal failures back off independently per hostname: 2, 4, 8, 16,
32, then 48 hours, capped at 48 hours. A longer CA `Retry-After` takes precedence;
HTTP 429 and 503 responses conservatively pause the shared account. Probe and
issuance failures send at most one email per hostname per 24 hours. Successes
are logged without email. Mail delivery failures do not reset the notification
cooldown or stop other certificates from being processed.

The account, certificates, retry deadlines, and email cooldowns are saved
atomically in `certificates.json` with owner-only permissions. Keep this file
across deployments. The old `certificate.json` is imported on first startup and
left untouched; its shared certificate continues serving names until their
individual replacements are ready. Keep both files during migration.

For testing, `certStaging: true` selects Let's Encrypt's staging API and
`certificates-staging.json`. It does not import the production account or legacy
certificate. Staging certificates are not trusted by browsers, so use this option
only on a test instance.

## User manual

See https://dwbe.org/manual/

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


## License

MIT
