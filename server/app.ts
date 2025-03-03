global.Promise = require("bluebird")

import express = require("express")
import fs = require("fs")
import url = require("url")
import http = require("http")
import https = require("https")
import RateLimit = require("express-rate-limit")

import expander = require("./expander")
import gitfs = require("./gitfs")
import tools = require("./tools")
import bluebird = require("bluebird")
import auth = require("./auth")
import events = require("./events")
import events2 = require("./events2")
import winston = require("winston")
import logs = require("./logs")
import epub = require("./epub")
import routing = require("./routing")
import rest = require("./rest")
import acme = require("./acme")
import oauth = require("./oauth")
import counter = require("./counter")

import { Message } from "./mail"
import { sendAsync } from "./mail"

bluebird.longStackTraces()
logs.init()

// the client enforces smaller
const maxImageSize = 2 * 1024 * 1024

const restartMinutes = 120

const startTime = Date.now()
let lastUse = startTime

const app = express()
const bodyParser = require("body-parser")
const pageCache = new tools.HtmlCache()

const fileLocks = tools.promiseQueue()

let ownSSL = false

if (gitfs.config && gitfs.config.proxy) {
    app.enable("trust proxy") // Rate limiter - only if you're behind a reverse proxy (Heroku, Bluemix, AWS ELB, Nginx, etc)
}

app.use((req, res, next) => {
    winston.debug(req.method + " " + req.header("host") +
        req.url + " " + req.header("user-agent"))
    req._response = res
    lastUse = Date.now()
    next()
})

setInterval(() => {
    let now = Date.now()
    let tm = now - startTime
    if (tm > restartMinutes * 60 * 1000) {
        // only restart when it's quiet
        if (now - lastUse > 10 * 1000) {
            winston.info(`auto-shutdown after ${Math.round(tm / 1000)}s`)
            gitfs.shutdown()
        }
    }
}, 60 * 1000)

app.use(require("cookie-parser")())
app.use(require("compression")())
app.use(
    bodyParser.json({
        limit: 5 * 1024 * 1024,
    })
)
app.use(
    bodyParser.urlencoded({
        extended: false,
    })
)

app.use((req, res, next) => {
    res.setHeader("X-XSS-Protection", "1")
    res.setHeader("X-Content-Type-Options", "nosniff")

    if (req.url.startsWith("/.well-known/")) {
        next()
        return
    }

    if (gitfs.config.proxy) {
        let hts =
            "https://" + (req.header("x-forwarded-host") || req.header("host"))
        if (hts == gitfs.config.authDomain) {
            res.setHeader("Strict-Transport-Security", "max-age=31536000")
        }

        if (req.header("x-forwarded-protocol") == "http") {
            res.redirect(hts + req.url)
            return
        }
    }

    if (ownSSL && !req.secure && !req.header("x-forwarded-for")) {
        let hts = "https://" + req.header("host")
        res.redirect(hts + req.url)
        return
    }

    // refresh in background if needed
    tools.values(gitfs.repos).forEach(r => r.pokeAsync())

    next()
})

auth.initCheck(app)
oauth.earlyInit(app)
auth.initRoutes(app)
epub.init(app)
acme.init(app)

interface ImgData {
    page: string
    full: string
    filename: string
    format: string
}

app.get("/api/logs", (req, res) => {
    if (!req.appuser) tools.throwError(402)
    res.contentType("text/plain")
    res.send(logs.getLogs())
})

function sanitizePath(p: string) {
    p = p + ""
    let elts = p.split(/\//).filter(s => !!s && s[0] != ".")
    if (elts.length && p.endsWith("/")) elts.push("")
    return elts
}

app.get("/api/history", (req, res) => {
    if (!req.appuser) tools.throwError(402)
    let p = sanitizePath(tools.getQuery(req, "path", "/")).join("/")

    gitfs
        .findRepo(p)
        .logAsync(p || ".")
        .then(j => res.json(j))
})

export const onSendEmail: (cfg: gitfs.Config) => express.RequestHandler =
    cfg => async (req, res) => {
        const msg = req.body as Message
        const allowed = (cfg.allowedEmailRecipients || []).find(
            o => o === req.body.to
        )
        winston.info("api-send allowed: " + allowed + " " + JSON.stringify(msg))

        if (!allowed) {
            res.status(405).end()
            return
        }

        try {
            await sendAsync(msg, cfg)
            res.status(200).end()
        } catch (err) {
            winston.error("api-send error:" + err)
            res.status(422).end()
        }
    }

const limiter = RateLimit({
    max: 3, // limit each IP to 3 requests per one minute
})

app.use("/api/send-email", limiter)
app.post("/api/send-email", onSendEmail(gitfs.config))

const cntlimiter = RateLimit({
    max: 5, // req/minute
})

app.use("/api/post-count", cntlimiter)
app.post("/api/post-count", async (req, res) => {
    try {
        const body = req.body as counter.CountPost

        if (!body.from) body.from = ""
        if (!body.comment) body.comment = ""
        if (!body.password) body.password = ""

        const count = +body.count | 0
        if (
            count <= 0 ||
            typeof body.path != "string" ||
            typeof body.from != "string" ||
            typeof body.comment != "string" ||
            (body.from + body.comment + body.password).length > 500
        )
            tools.throwError(400)

        const m = /^\/([\w\-]+)/.exec(body.path)
        if (!m || m[1].length > 60) tools.throwError(400)
        const cntid = m[1]

        const cfg = await expander.getPageConfigAsync("/" + cntid)

        if (
            cfg.countPassword &&
            simplifyPassword(cfg.countPassword) !=
            simplifyPassword(body.password)
        )
            tools.throwError(403)

        if (!cfg.maxCount) tools.throwError(405)
        if (count > cfg.maxCount) tools.throwError(412)

        res.json(
            counter.addCount(cntid, {
                count,
                from: body.from || undefined,
                comment: body.comment || undefined,
                now: Date.now(),
            })
        )
    } catch (e) {
        if (e.statusCode) res.status(e.statusCode).end()
        else throw e
    }

    function simplifyPassword(s: string) {
        return s.toLowerCase().replace(/[^a-z0-9]/g, "")
    }
})

app.post("/api/uploadimg", (req, res) => {
    if (!req.appuser) return res.status(403).end()

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
    let buf = Buffer.from(data.full, "base64")
    if (buf.length > maxImageSize) return res.status(413).end()

    let msg = "Image at " + path + " / " + basename + ext

    expander.hasWritePermAsync(req.appuser, path).then(hasPerm => {
        if (!hasPerm) return res.status(403).end()

        fileLocks(path, () =>
            gitfs
                .findRepo(path)
                .createBinFileAsync(path, basename, ext, buf, msg, req.appuser)
                .then(imgName => {
                    res.json({
                        url: "img/" + imgName,
                    })
                })
        )
    })
})

app.post("/api/replaceimg", (req, res) => {
    if (!req.appuser) return res.status(403).end()

    let data = req.body as ImgData
    let pathElts = sanitizePath(data.filename)
    let path = pathElts.join("/")

    let buf = Buffer.from(data.full, "base64")
    if (buf.length > maxImageSize) return res.status(413).end()

    let msg =
        "Replace image at " + path + " " + Math.round(buf.length / 1024) + "k"

    expander.hasWritePermAsync(req.appuser, path).then(hasPerm => {
        if (!hasPerm) return res.status(403).end()

        fileLocks(path, () =>
            gitfs
                .findRepo(path)
                .setBinFileAsync(path, buf, msg, req.appuser)
                .then(() => {
                    res.json({})
                })
        )
    })
})

app.get("/api/refresh", (req, res) => {
    if (!req.appuser) return res.status(403).end()
    gitfs
        .findRepo(tools.getQuery(req, "path"))
        .pokeAsync(true)
        .then(() => {
            res.json({})
        })
})

app.post("/api/update", (req, res) => {
    if (!req.appuser) return res.status(403).end()

    let page = req.body.page + ""

    page = page.replace(/\.html?$/i, "")

    if (page.endsWith("/")) page += "index"
    page = page.replace(/\/\d+$/, "/_event")

    let fn = page.slice(1) + ".html"
    if (fn.indexOf("private") == 0) return res.status(402).end()

    let repo = gitfs.findRepo(fn)

    let lang: string = req.body.lang
    let cfg: expander.ExpansionConfig = {
        rootFile: fn,
        ref: "master",
        langs: lang ? [lang] : null,
        appuser: req.appuser,
    }

    fileLocks(
        fn,
        () =>
            expander.expandFileAsync(cfg).then(page => {
                if (!cfg.hasWritePerm) return res.status(402).end()

                let id: string = req.body.id
                let val: string = req.body.value
                let desc = page.idToPos[id]

                if (lang && cfg.lang != lang) {
                    // didn't manage to set this language
                    return res.status(411).end()
                }

                if (req.body.alltranslations) {
                    let numadded = 0
                    for (let k of Object.keys(page.idToPos)) {
                        let dd = page.idToPos[k]
                        if (page.langMap[k] === undefined) {
                            let v = page.allFiles[dd.filename].slice(
                                dd.startIdx,
                                dd.startIdx + dd.length
                            )
                            numadded++
                            cfg.langFileContent = expander.setTranslation(
                                cfg,
                                k,
                                v
                            )
                        }
                    }
                    if (numadded)
                        fs.writeFileSync("lang.html", cfg.langFileContent)
                    return res.end("OK")
                }

                val = expander.cleanHtmlFragment(val)

                if (cfg.langFileName) {
                    let newCont = expander.setTranslation(cfg, id, val)
                    repo.setTextFileAsync(
                        cfg.langFileName,
                        newCont,
                        "Translate " + cfg.langFileName + " / " + id,
                        req.appuser
                    ).then(() => res.end("OK"))
                } else if (desc) {
                    let cont = page.allFiles[desc.filename]
                    let newCont =
                        cont.slice(0, desc.startIdx) +
                        val +
                        cont.slice(desc.startIdx + desc.length)
                    repo.setTextFileAsync(
                        desc.filename,
                        newCont,
                        "Update " + desc.filename + " / " + id,
                        req.appuser
                    ).then(() => res.end("OK"))
                } else {
                    res.status(410).end()
                }
            }) as Promise<void>
    )
})

// support let's encrypt cert renewal (when hidden behind apache)
//app.use("/.well-known", express.static("/var/www/html/.well-known"))
app.use("/map-cache", express.static("map-cache"))
app.use("/cdn/map-cache", express.static("map-cache"))

app.get(
    /^\/cdn\/(([\w\-]+)\/)?(.*-|)([0-9a-f]{40})([-\.].*)/,
    (req, res, next) => {
        let id = req.params[1] || "main"
        let sha = req.params[3]
        let filename = req.params[4]
        let repo = tools.lookup(gitfs.repos, id)
        if (!repo) repo = gitfs.main
        if (filename[0] == ".") filename = "blob" + filename
        if (tools.etagMatches(req, sha + "-0")) return
        repo.getFileAsync(sha, "SHA").then(
            buf => {
                tools.allowReqCache(req)
                res.writeHead(200, {
                    "Content-Type": tools.mimeLookup(filename),
                    "Content-Length": buf.length,
                })
                res.end(buf)
            },
            e => {
                winston.info("error (cdn): " + req.path + " " + e.message)
                res.removeHeader("ETag")
                res.status(404).end("Page not found (CDN)")
            }
        )
    }
)

function needsOAuth(cfg: expander.PageConfig) {
    // only require oauth, when it's configured (ie., not on localhost)
    return cfg.oauth && !!gitfs.config.oauth
}

async function genericGet(req: express.Request, res: express.Response) {
    if (!tools.reqSetup(req)) return

    let cleaned = req.path.replace(/\/index(\.html?)?$/, "/")
    if (cleaned != req.path) {
        return res.redirect(cleaned + req.url.slice(req.path.length + 1))
    }

    if (/\/$/.test(cleaned)) cleaned += "index"

    const redir = routing.getVHostRedir(req)
    if (redir) return res.redirect(redir)

    if (!/^\/(common|gw|gwcdn)\//.test(cleaned)) {
        cleaned = routing.getVHostDir(req) + cleaned
    }

    cleaned = cleaned.slice(1)

    if (cleaned.endsWith("/edit")) {
        let redirpath = "/" + cleaned.slice(0, cleaned.length - 5)
        if (req.appuser) return res.redirect(redirpath)
        return res.redirect(
            gitfs.config.authDomain +
            "/gw/login?redirect=" +
            encodeURIComponent(redirpath)
        )
    }

    // asking for root index?
    if (cleaned == "index") {
        res.redirect(gitfs.config.defaultRedirect || "/sample/")
        return
    }

    let ref = "master"
    if (/^[0-9a-f]{40}\//.test(cleaned)) {
        ref = cleaned.slice(0, 40)
        cleaned = cleaned.slice(41)
    }

    if (/^(private|logs\/)/.test(cleaned)) return notFound(req, "Private.")

    cleaned = cleaned.replace(/\.html?$/i, "")

    let spl = gitfs.splitName(cleaned)
    let isHtml = spl.name.indexOf(".") < 0

    if (spl.name == "config.json" || /\/[\._]/.test(cleaned))
        return notFound(req, "Hidden.")

    let gitFileName = cleaned
    let eventId = 0
    if (/^\d+$/.test(spl.name)) {
        eventId = parseInt(spl.name)
        gitFileName = cleaned.replace(/\d+$/, "_event")
    }

    let errHandler = (e: any) => {
        let msg = e.message
        if (!/ENOENT/.test(msg)) msg = e.stack
        winston.info("error: " + cleaned + " " + msg)
        if (req.appuser) {
            res.status(500)
            routing.sendError(
                req,
                "Page not found",
                "Something went wrong. " + tools.htmlQuote(e.message)
            )
        } else {
            notFound(req)
        }
    }

    let repo = gitfs.findRepo(gitFileName)

    if (!isHtml) {
        repo.getFileAsync(gitFileName, ref)
            .then(
                v => v,
                err => {
                    if (gitFileName.endsWith("favicon.ico"))
                        return repo.getFileAsync("favicon.ico", ref)
                    if (err.code == "EISDIR") {
                        res.redirect(req.path + "/")
                        return null
                    }
                    return Promise.reject(err)
                }
            )
            .then(async buf => {
                if (!buf) return Promise.resolve()
                let cfg = await expander.getPageConfigAsync(cleaned)
                if (
                    cfg.private &&
                    !(await auth.hasWritePermAsync(req.appuser, cfg.users))
                ) {
                    notFound(req, "Private.")
                } else if (needsOAuth(cfg) && !req.oauthuser) {
                    notFound(req, "OAuth required.")
                } else {
                    res.writeHead(200, {
                        "Content-Type": tools.mimeLookup(gitFileName),
                        "Content-Length": buf.length,
                    })
                    res.end(buf)
                }
            })
            .catch(errHandler)
        return
    }

    gitFileName += ".html"

    let cacheKey =
        ref +
        ":" +
        cleaned +
        ":" +
        JSON.stringify(req.query) +
        req.langs.join(",")
    if (req.appuser || gitfs.config.justDir) cacheKey = null

    let hasRoPerm = false
    if (gitfs.config.roSecret) {
        if (req.header("x-gitwed-secret") == gitfs.config.roSecret)
            hasRoPerm = true
    }

    let cached = pageCache.get(cacheKey)
    if (cached && cached.isPrivate && !hasRoPerm) cached = null
    if (cached && cached.isOAuth && !req.oauthuser) cached = null
    if (cached != null) {
        winston.debug(`cache hit at ${cacheKey}`)
        res.writeHead(200, {
            "Content-Type": "text/html; charset=utf8",
        })
        return res.end(cached.html)
    }

    type Template = { name: string; content: string; filename: string }
    const defaultTemplates: SMap<string> = { "_new.html": "Standard page" }

    const getTemplatesContent = async (
        base: string,
        templates: SMap<string>
    ): Promise<Template[]> => {
        const templateArray: Promise<Template>[] = []

        Object.keys(templates || {}).forEach(filename =>
            templateArray.push(
                new Promise<Template>(async res => {
                    let content = null
                    try {
                        content = await repo.getTextFileAsync(
                            base + "/" + filename,
                            ref
                        )
                    } catch { }
                    res({ name: templates[filename], content, filename })
                })
            )
        )

        const ts: Template[] = []
            ; (await Promise.all(templateArray)).forEach(p =>
                p.content ? ts.push(p) : null
            )
        return ts
    }

    let str = await repo.getTextFileAsync(gitFileName, ref).then(
        v => v,
        err =>
            repo
                .getTextFileAsync(cleaned + "/index.html")
                .then(
                    () => res.redirect(req.path + "/"),
                    async _ => {
                        if (!req.appuser) {
                            notFound(req)
                            return
                        }

                        let base = cleaned.replace(/\/[^/]*$/, "")
                        try {
                            const pcfg = await expander.getPageConfigAsync(base)
                            const templates = await getTemplatesContent(
                                base,
                                pcfg.templates || defaultTemplates
                            )

                            if (!templates.length) {
                                notFound(
                                    req,
                                    base +
                                    JSON.stringify(templates) +
                                    " files are missing!"
                                )
                                return
                            }

                            if (req.query["create"] !== "true") {
                                notFound(
                                    req,
                                    "<ul>" +
                                    templates
                                        .map(
                                            t =>
                                                `<li><a href="${req.path
                                                }?create=true&template=${t.filename.replace(
                                                    ".html",
                                                    ""
                                                )}">Create ${t.name
                                                }</a></li>`
                                        )
                                        .join("") +
                                    "</ul>"
                                )
                                return
                            }
                            const templateFilename =
                                req.query["template"] + ".html"
                            if (
                                !/^[a-zA-Z0-9_-]+.html$/.test(
                                    templateFilename
                                ) ||
                                !templates.find(
                                    t => t.filename === templateFilename
                                )
                            ) {
                                notFound(
                                    req,
                                    base + `/${templateFilename} is missing!`
                                )
                                return
                            }

                            if (
                                !(await auth.hasWritePermAsync(
                                    req.appuser,
                                    pcfg.users
                                ))
                            ) {
                                notFound(
                                    req,
                                    "No permission to create a new page here."
                                )
                                return
                            }

                            await repo.setTextFileAsync(
                                gitFileName,
                                templates.find(
                                    t => t.filename === templateFilename
                                ).content,
                                `Create based on ${templateFilename}`,
                                req.appuser
                            )
                            res.redirect(req.path)
                        } catch (err) {
                            notFound(req, err)
                            return
                        }
                    }
                )
                .then(() => null as string)
    )

    if (str == null) return
    try {
        let cfg: expander.ExpansionConfig = {
            rootFile: gitFileName,
            origHref: req.url,
            origQuery: tools.convertQuery(req.query),
            ref,
            rootFileContent: str,
            langs: req.langs,
            appuser: req.appuser,
            oauthuser: req.oauthuser,
            eventId,
        }

        let page = await expander.expandFileAsync(cfg)

        if (cfg.pageConfig.private && !cfg.hasWritePerm && !hasRoPerm) {
            return res.redirect(
                gitfs.config.authDomain +
                "/gw/login?redirect=" +
                encodeURIComponent("/" + cleaned)
            )
        }

        if (needsOAuth(cfg.pageConfig) && !req.oauthuser) {
            const here = url.format({
                protocol: req.protocol,
                host: req.header("host"),
                pathname: req.path,
            })
            return res.redirect(
                gitfs.config.authDomain +
                "/oauth/login?redirect=" +
                encodeURIComponent(here)
            )
        }

        pageCache.set(cacheKey, {
            html: page.html,
            isPrivate: cfg.pageConfig.private,
            isOAuth: needsOAuth(cfg.pageConfig),
        })
        res.writeHead(200, {
            "Content-Type": "text/html; charset=utf8",
        })
        res.end(page.html)
    } catch (err) {
        errHandler(err)
    }
}

function notFound(req: express.Request, msg = "") {
    let res = req._response as express.Response
    res.status(404)
    routing.sendError(
        req,
        "Page not found",
        "Whoops! We couldn't find the page your were looking for. " + msg
    )
}

function setupFinalRoutes() {
    app.get(/.*/, genericGet)

    app.use((req, res) => notFound(req))

    app.use(
        (
            error: any,
            req: express.Request,
            res: express.Response,
            next: express.NextFunction
        ) => {
            logs.logError(error, req)
        }
    )
}

let cfg: gitfs.Config = {} as any
if (fs.existsSync("config.json"))
    cfg = JSON.parse(fs.readFileSync("config.json", "utf8"))
rest.init(cfg.services || [])
cfg.justDir = true
let args = process.argv.slice(2)
if (args[0] == "-i") {
    args.shift()
    cfg.justDir = false
}
if (args[0] == "-cdn") {
    args.shift()
    if (!cfg.cdnPath) {
        cfg.cdnPath = "/cdn"
    }
}
if (args[0] && fs.existsSync(args[0])) {
    cfg.repoPath = args[0]
    args.shift()
}

if (!cfg.repoPath) cfg.repoPath = "."

if (args[0]) {
    winston.error("parameter not understood: " + args[0])
    console.error(`Usage: gitwed [-i] [-cdn] [DIRECTORY]`)
    process.exit(1)
}
if (!cfg.networkInterface) cfg.networkInterface = "localhost"

let port = process.env.PORT ? +process.env.PORT : 3000

if (!cfg.authDomain) cfg.authDomain = `http://${cfg.networkInterface}:${port}`

if (!cfg.serviceName) cfg.serviceName = "GITwed"

if (!cfg.justDir && !cfg.cdnPath) cfg.cdnPath = "/cdn"

if (!cfg.repoPath || !fs.existsSync(cfg.repoPath)) {
    winston.error(
        `cannot find repoPath (${cfg.repoPath}) in config.json or as argument`
    )
    process.exit(1)
}

if (!cfg.vhosts) cfg.vhosts = {}

if (cfg.justDir) {
    winston.info(`using local file modifications`)
} else {
    winston.info(`using git push/pull`)
}

process.on("SIGINT", () => {
    gitfs.shutdown()
})

process.on("SIGTERM", () => {
    gitfs.shutdown()
})

gitfs.initAsync(cfg).then(() => {
    for (let r of tools.values(gitfs.repos)) {
        r.onUpdate(() => pageCache.flush())
    }
    oauth.init(app)
    events.initRoutes(app)
    events2.initRoutes(app)
    setupFinalRoutes()

    if (cfg.justDir || cfg.proxy) {
        winston.info(`listen on http://${cfg.networkInterface}:${port}`)
        app.listen(port, cfg.networkInterface)
    } else {
        if (cfg.production) {
            winston.info(`setup certs`)
            ownSSL = true
            acme.setupCertsAndListen(app, cfg)
        } else {
            winston.info(`listen on http://*:${port}`)
            app.listen(port)
        }
    }
})
