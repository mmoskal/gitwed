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
    (<any>req)._response = res;
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

app.post("/api/uploadimg", (req, res) => {
    if (!req.appuser)
        return res.status(403).end()

    let data = req.body as ImgData
    let pathElts = data.page.split(/\//).filter(s => !!s)
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
            .then(fullPath => {
                res.json({
                    url: "/" + fullPath
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
//app.use("/gw", express.static("node_modules/ContentTools/build"))
//app.use("/", express.static("html"))

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

    if (cleaned.indexOf("private") == 0)
        return next()

    let spl = gitfs.splitName(cleaned)
    let isHtml = spl.name.indexOf(".") < 0

    if (isHtml) cleaned += ".html"
    gitfs.getFileAsync(cleaned)
        .then(buf => {
            if (isHtml) {
                let cfg: expander.ExpansionConfig = {
                    rootFile: cleaned,
                    rootFileContent: buf.toString("utf8"),
                    langs
                }
                expander.expandFileAsync(cfg)
                    .then(page => {
                        let html = page.html
                        if (req.appuser) {
                            html = html
                                .replace("<!-- @GITWED-EDIT@", "")
                                .replace("@GITWED-EDIT@ -->", "")
                        }
                        let pageInfo = {
                            user: req.appuser || null,
                            lang: cfg.lang,
                            langFileCreated: !!cfg.langFileContent,
                            availableLangs: cfg.pageConfig.langs,
                            isDefaultLang: cfg.lang == cfg.pageConfig.langs[0],
                            path: cleaned,
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
    res.status(404).send('Page not found');
})

app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    logs.logError(error, req)
})

let dataDir = process.argv[2]
let cfg: gitfs.Config = {} as any
if (fs.existsSync("config.json"))
    cfg = JSON.parse(fs.readFileSync("config.json", "utf8"))
else if (!dataDir) {
    winston.error("need either config.json or data dir argument")
    process.exit(1)
}

if (dataDir) {
    winston.info('Using local datadir: ' + dataDir)
    cfg.localRepo = dataDir
}

gitfs.initAsync(cfg)
    .then(() => {
        if (cfg.localRepo) app.listen(3000, "localhost")
        else app.listen(3000)
    })

//expander.test()