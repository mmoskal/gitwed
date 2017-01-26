global.Promise = require("bluebird")

import express = require('express');
import mime = require('mime');
import fs = require('fs');
import crypto = require("crypto")
import expander = require('./expander')
import gitfs = require('./gitfs')
import tools = require('./tools')
import bluebird = require('bluebird')
import auth = require('./auth')
import winston = require('winston')
import logs = require('./logs')

bluebird.longStackTraces();
logs.init()

var app = express();
var bodyParser = require('body-parser')

let fileLocks = tools.promiseQueue()

app.use((req, res, next) => {
    winston.debug(req.method + " " + req.url);
    req._response = res;
    next();
});

app.use(require('cookie-parser')());
app.use(require("compression")())
app.use(bodyParser.json({
    limit: 5 * 1024 * 1024
}))


auth.initCheck(app)

app.get('/', (req, res) => {
    res.redirect("/sample/index")
})

auth.initRoutes(app)

interface ImgData {
    page: string;
    full: string;
    thumb: string;
    filename: string;
    format: string;
}

app.get("/api/logs", (req, res) => {
    if (!req.appuser)
        tools.throwError(402)
    res.contentType("text/plain");
    res.send(logs.getLogs())
})

function sanitizePath(p: string) {
    p = p + ""
    return p.split(/\//).filter(s => !!s && s != "." && s != "..")
}

app.get("/api/history", (req, res) => {
    if (!req.appuser)
        tools.throwError(402)
    let p = sanitizePath(req.query["path"] || "/").join("/")

    gitfs.logAsync(p || ".")
        .then(j => res.json(j))
})

app.post("/api/uploadimg", (req, res) => {
    if (!req.appuser)
        return res.status(403).end()

    let data = req.body as ImgData
    let pathElts = sanitizePath(data.page)
    pathElts.pop()
    pathElts.push("img")
    let path = pathElts.join("/")
    let basename = data.filename
        .replace(/.*[\/\\]/, "")
        .toLowerCase()
        .replace(/\.[a-z]+$/, "")
        .replace(/[^\w\-]+/g, "_")
    let ext = "." + data.format
    let buf = new Buffer(data.full, "base64")
    let msg = "Image at " + path + " / " + basename + ext + " by " + req.appuser

    fileLocks(path, () =>
        gitfs.refreshAsync()
            .then(() => gitfs.createBinFileAsync(path, basename, ext, buf, msg))
            .then(imgName => {
                res.json({
                    url: "img/" + imgName
                })
            }))
})

app.post("/api/update", (req, res) => {
    if (!req.appuser)
        return res.status(403).end()

    let fn = req.body.page.slice(1) + ".html"
    if (fn.indexOf("private") == 0)
        return res.status(402).end()

    let lang: string = req.body.lang
    let cfg: expander.ExpansionConfig = {
        rootFile: fn,
        ref: "master",
        langs: lang ? [lang] : null
    }

    fileLocks(fn, () =>
        gitfs.refreshAsync()
            .then(() => expander.expandFileAsync(cfg))
            .then(page => {
                let id: string = req.body.id
                let val: string = req.body.value
                let desc = page.idToPos[id]

                if (lang && cfg.lang != lang) {
                    // didn't manage to set this language
                    return res.status(411).end()
                }

                val = "\n" + val + "\n"
                val = val.replace(/\r/g, "")
                val = val.replace(/(^\n+)|(\n+$)/g, "\n")

                if (cfg.langFileName) {
                    let newCont = expander.setTranslation(cfg, id, val)
                    gitfs.setTextFileAsync(cfg.langFileName, newCont,
                        "Translate " + cfg.langFileName + " / " + id + " by " + req.appuser)
                        .then(() => res.end("OK"))
                } else if (desc) {
                    let cont = page.allFiles[desc.filename]
                    let newCont = cont.slice(0, desc.startIdx) + val + cont.slice(desc.startIdx + desc.length)
                    gitfs.setTextFileAsync(desc.filename, newCont,
                        "Update " + desc.filename + " / " + id + " by " + req.appuser)
                        .then(() => res.end("OK"))
                } else {
                    res.status(410).end()
                }
            }))
})

app.use("/gw", express.static("built/gw"))
app.use("/gw", express.static("gw"))
// support let's encrypt cert renewal (when hidden behind apache)
app.use("/.well-known", express.static("/var/www/html/.well-known"))
//app.use("/gw", express.static("node_modules/ContentTools/build"))
//app.use("/", express.static("html"))

app.get(/^\/cdn\/(.*-|)([0-9a-f]{40})([-\.].*)/, (req, res, next) => {
    let sha = req.params[1]
    let filename = req.params[2]
    if (filename[0] == ".") filename = "blob" + filename
    if (tools.etagMatches(req, sha + "-0"))
        return
    tools.allowReqCache(req)
    gitfs.getFileAsync(sha, "SHA")
        .then(buf => {
            res.writeHead(200, {
                'Content-Type': mime.lookup(filename),
                'Content-Length': buf.length
            })
            res.end(buf)
        }, e => {
            winston.info("error (cdn): " + req.path + " " + e.message)
            res.status(404).end('Page not found (CDN)');
        })
})

app.get(/.*/, (req, res, next) => {
    if (req.query["setlang"] != null) {
        res.cookie("GWLANG", req.query['setlang'] || "")
        return res.redirect(req.path)
    }

    let langs: string[] = []
    let addLang = (s: string) => {
        if (!s) return
        s = s.toLowerCase()
        let m = /^([a-z]+)(-[a-z]+)?/.exec(s)
        if (m) {
            let full = m[1] + m[2]
            if (langs.indexOf(full) >= 0) return
            langs.push(full)
            if (m[1] != full)
                langs.push(m[1])
        }
    }

    addLang(req.query["lang"])
    addLang(req.cookies['GWLANG'])
    for (let s of (req.header("Accept-Language") || "").split(",")) {
        let headerLang = (/^\s*([A-Za-z\-]+)/.exec(s) || [])[1];
        addLang(headerLang)
    }

    let cleaned = req.path.replace(/\/+$/, "")
    if (cleaned != req.path) {
        return res.redirect(cleaned + req.url.slice(req.path.length + 1))
    }

    cleaned = cleaned.slice(1)

    let ref = "master"
    if (/^[0-9a-f]{40}\//.test(cleaned)) {
        ref = cleaned.slice(0, 40)
        cleaned = cleaned.slice(41)
    }

    if (cleaned.indexOf("private") == 0)
        return next()

    let spl = gitfs.splitName(cleaned)
    let isHtml = spl.name.indexOf(".") < 0

    if (isHtml) cleaned += ".html"
    gitfs.getFileAsync(cleaned, ref)
        .then(buf => {
            if (isHtml) {
                let cfg: expander.ExpansionConfig = {
                    rootFile: cleaned,
                    ref,
                    rootFileContent: buf.toString("utf8"),
                    langs
                }
                expander.expandFileAsync(cfg)
                    .then(page => {
                        let html = page.html
                        if (!req.appuser) {
                            html = html
                                .replace(/<!-- @GITWED-EDIT@ -->[^]*?<!-- @GITWED-EDIT-END@ -->/, "")
                        }
                        let pageInfo = {
                            user: req.appuser || null,
                            lang: cfg.lang,
                            langFileCreated: !!cfg.langFileContent,
                            availableLangs: cfg.pageConfig.langs,
                            isDefaultLang: cfg.lang == cfg.pageConfig.langs[0],
                            path: cleaned,
                            isEditable: ref == "master",
                            ref: ref,
                        }
                        html = html.replace("@GITWED-PAGE-INFO@",
                            "\nvar gitwedPageInfo = " + JSON.stringify(pageInfo, null, 4) + ";\n")
                        res.writeHead(200, {
                            'Content-Type': 'text/html; charset=utf8'
                        })
                        res.end(html)
                    })
                    .then(v => v, next)
            } else {
                res.writeHead(200, {
                    'Content-Type': mime.lookup(cleaned),
                    'Content-Length': buf.length
                })
                res.end(buf)
            }
        }, e => {
            winston.info("error: " + cleaned + " " + e.message)
            next()
        })
})

app.use((req, res) => {
    res.status(404).end('Page not found');
})

app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    logs.logError(error, req)
})

let cfg: gitfs.Config = {} as any
if (fs.existsSync("config.json"))
    cfg = JSON.parse(fs.readFileSync("config.json", "utf8"))
cfg.justDir = true
let args = process.argv.slice(2)
if (args[0] == "-i") {
    args.shift()
    cfg.justDir = false
}
if (args[0]) {
    cfg.repoPath = args[0]
}

if (!cfg.repoPath || !fs.existsSync(cfg.repoPath)) {
    winston.error(`cannot find repoPath (${cfg.repoPath}) in config.json or as argument`)
    process.exit(1)
}

let port = 3000

gitfs.initAsync(cfg)
    .then(() => {
        if (cfg.justDir) {
            winston.info(`listen on http://localhost:${port} using local file modifications`)
            app.listen(port, "localhost")
        } else {
            winston.info(`listen on http://*:${port} with git push/pull`)
            app.listen(port)
        }
    })
