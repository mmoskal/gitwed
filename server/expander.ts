import cheerio = require("cheerio")
import gitfs = require('./gitfs')
import * as bluebird from "bluebird";
import * as winston from "winston";

let htmlparser2 = require("htmlparser2")

function jsQuote(s: string) {
    return "\"" + s.replace(/[\\"\n\r\t]/g, (m) => {
        switch (m) {
            case "\\":
            case "\"": return "\\" + m;
            case "\n": return "\\n";
            case "\r": return "\\r";
            case "\t": return "\\t";
            default: return m;
        }
    }) + "\""
}

function error(msg: string, ctx?: Ctx, elt?: Cheerio) {
    if (ctx)
        msg += " at " + ctx.filename

    if (elt && elt[0] && elt[0].startIndex != null) {
        let idx = elt[0].startIndex
        msg += "@" + idx
        if (ctx)
            msg += "  ..." +
                ctx.fileContent.slice(Math.max(0, idx - 10), idx) +
                "*" +
                ctx.fileContent.slice(idx, idx + 20) + "..."
    }

    throw new Error(msg)
}

interface Ctx {
    filename: string;
    subst: SMap<Cheerio>;
    fileContent: string;
}

interface Pos {
    filename: string;
    startIdx: number;
    length: number;
}

export interface PageConfig {
    langs?: string[];
}

export interface ExpansionConfig {
    rootFile: string;
    ref: string;
    rootFileContent?: string;
    lang?: string;
    langs?: string[];
    langFileName?: string;
    langFileContent?: string;
    pageConfig?: PageConfig;
}

function relativePath(curr: string, newpath: string) {
    if (newpath[0] == "/") return newpath

    let spl = gitfs.splitName(curr)
    let res = spl.parent + "/" + newpath
    res = res.replace(/\/+/g, "/")
    res = res.replace(/\/\.\//g, "/")
    res = res.replace(/^(\/\.\.\/)+/g, "/")
    res = res.replace(/\/[^\/]+\/\.\.\//g, "/")

    return res
}

let cheerioOptions: any = {
    lowerCaseTags: true,
    lowerCaseAttributeNames: true,
    recognizeSelfClosing: true,
    normalizeWhitespace: false,
    withStartIndices: true
}

export function setTranslation(cfg: ExpansionConfig, key: string, val: string) {
    let cont = cfg.langFileContent || ""
    if (cont) cont = cont.replace(/\n*$/, "\n\n")
    let h = cheerio.load(cont || "", cheerioOptions)
    let elt = h(`<div data-gw-id="${key}">${val}</div>`)
    h("[data-gw-id]").each((i, e) => {
        let ee = h(e)
        let id = ee.attr("data-gw-id")
        if (id == key) {
            ee.replaceWith(elt)
            elt = null
        }
    })
    if (elt) {
        h.root().append(elt)
    }
    return h.html()
}

function expandAsync(cfg: ExpansionConfig) {

    let filename = cfg.rootFile
    let fileContent = cfg.rootFileContent

    let hLoc = cfg.langFileContent ? cheerio.load(cfg.langFileContent, cheerioOptions) : null
    let h = cheerio.load(fileContent, cheerioOptions)

    let idToPos: SMap<Pos> = {}
    let allFiles: SMap<string> = {}
    let trees: SMap<Promise<gitfs.TreeEntry[]>> = {}

    setLocations(h.root(), filename, fileContent)
    return recAsync({ filename, subst: {}, fileContent }, h.root())
        .then(() => {
            h("group").each((i, e) => {
                h(e).replaceWith(e.childNodes)
            })
            h("[gw-pos]").each((i, e) => {
                let ee = h(e)
                let m = /(.*)@(\d+)-(\d+)/.exec(ee.attr("gw-pos"))
                let id = ee.attr("id")
                id = m[1].replace(/.*\//, "").replace(/\.html?$/i, "") + "-" + id
                id = id.replace(/[^\w]+/g, "_")
                ee.attr("data-gw-id", id)
                if (idToPos.hasOwnProperty(id))
                    // we don't want no duplicates
                    idToPos[id] = null
                else
                    idToPos[id] = {
                        filename: m[1],
                        startIdx: parseInt(m[2]),
                        length: parseInt(m[3])
                    }
                ee.removeAttr("edit")
                ee.removeAttr("gw-pos")
            })

            if (hLoc) {
                let langMap: SMap<string> = {}
                hLoc("[data-gw-id]").each((i, e) => {
                    let ee = hLoc(e)
                    let id = ee.attr("data-gw-id")
                    langMap[id] = ee.html()
                })
                h("[data-gw-id]").each((i, e) => {
                    let ee = h(e)
                    let id = ee.attr("data-gw-id")
                    if (langMap[id]) {
                        ee.html(langMap[id])
                    }
                })
            }
        })
        .then(cdnRewriteAsync)
        .then(() => {
            return {
                allFiles,
                idToPos,
                html: h.html()
            }
        })

    function getTreeAsync(path: string) {
        if (trees[path])
            return trees[path]
        return (trees[path] =
            gitfs.getTreeAsync(path, cfg.ref)
                .then(ents => {
                    if (!ents)
                        winston.debug("no such tree: " + path + " in " + cfg.ref)
                    return ents
                }))
    }

    function replUrlAsync(url: string) {
        let resolved = relativePath(cfg.rootFile, url)
        let spl = gitfs.splitName(resolved)
        return getTreeAsync(spl.parent)
            .then(ents => {
                if (!ents)
                    return url
                let e = ents.find(x => x.name == spl.name)
                if (e) {
                    let ext = spl.name.replace(/.*\./, ".")
                    return "/cdn/" + spl.name + "-" + e.sha + ext
                } else {
                    winston.debug("no such file: " + resolved + " in " + cfg.ref)
                    return url
                }
            })
    }

    function canBeCdned(v: string, canHaveRelativeLinks = false) {
        if (!v) return false
        if (/^[\w-]+:\/\//.test(v)) return false
        if (/^\/common\//.test(v)) return true
        if (canHaveRelativeLinks && !/(^|\/)cdn\//.test(v)) return false
        return true
    }

    function cdnRewriteAsync() {
        let promises: Promise<void>[] = []
        let replIdx = 0

        let repl = (e: CheerioElement, attrName: string, canHaveRelativeLinks = false) => {
            let ee = h(e)
            let v = ee.attr(attrName)
            if (!canBeCdned(v, canHaveRelativeLinks)) return
            promises.push(replUrlAsync(v).then(r => {
                winston.debug("repl: " + v + " -> " + r)
                ee.attr(attrName, r)
            }))
        }
        h("img, audio, video, track").each((idx, e) => {
            repl(e, "src")
            if (e.tagName != "img")
                repl(e, "poster")
        })
        h("script").each((idx, e) => {
            repl(e, "src", true)
        })
        h("link").each((idx, e) => {
            let ee = h(e)
            let rels = (ee.attr("rel") || "").split(/\s+/)
            if (rels.indexOf("stylesheet") >= 0)
                repl(e, "href", true)
            if (rels.indexOf("icon") >= 0)
                repl(e, "href")
        })
        h("style").each((idx, e) => {
            let ee = h(e)
            let lprom: Promise<void>[] = []
            let map: SMap<string> = {}
            let addrepl = (s: string) => {
                s = s.trim()
                let m = /^'(.*)'$/.exec(s)
                if (m) s = m[1]
                m = /^"(.*)"$/.exec(s)
                if (m) s = m[1]
                let tag = "##REPL##" + ++replIdx + "#"
                if (canBeCdned(s, true)) {
                    lprom.push(replUrlAsync(s).then(r => {
                        map[tag] = r
                    }))
                } else {
                    map[tag] = s
                }
                return tag
            }
            let t0 = ee.text()
                .replace(/url\(([^\)]+)\)/g, (f, u) => "url(" + addrepl(u) + ")")
                .replace(/@import ("[^"]+"|'[^']+')/g, (f, u) => "@import " + addrepl(u))
            promises.push(Promise.all(lprom)
                .then(() => {
                    ee.text(t0.replace(/##REPL##\d+#/g, f => "\"" + map[f] + "\""))
                }))
        })

        return Promise.all(promises)
    }

    function setLocations(e: Cheerio, filename: string, fileContent: string) {
        allFiles[filename] = fileContent
        let mapping: SMap<number> = {}
        let parser: any
        let handler = new htmlparser2.DomHandler(cheerioOptions, (elt: CheerioElement) => {
            //console.log(elt.tagName, elt.startIndex, parser.endIndex)
            mapping[elt.startIndex + ""] = parser.startIndex
        });
        parser = new htmlparser2.Parser(handler, cheerioOptions)
        parser.end(fileContent);

        e.find("[edit]").each((i, ch) => {
            let x = h(ch)
            let start = ch.startIndex
            let end = mapping[start + ""]
            if (fileContent[start] == "<") {
                while (start < fileContent.length && fileContent[start] != ">")
                    start++;
                start++;
            }
            //console.log(`${ch.tagName}: "${fileContent.slice(start, end)}"`)
            x.attr("gw-pos", filename + "@" + start + "-" + (end - start))
        })
    }

    function includeAsync(ctx: Ctx, e: Cheerio, filename: string) {
        filename = relativePath(ctx.filename, filename)
        return gitfs.getTextFileAsync(filename, cfg.ref)
            .then(fileContent => {
                let subst: SMap<Cheerio> = {}
                for (let ch of e.children().toArray()) {
                    let ch2 = h(ch)
                    let id = ch2.attr("id")
                    if (id) {
                        subst[id] = ch2;
                        ch2.gw_ctx = ctx; // save outer ctx for further expansion and filename tracking
                    }
                }
                let n = h(fileContent)
                setLocations(n, filename, fileContent)
                e.replaceWith(n)
                return recAsync({ subst, filename, fileContent }, n)
            })
    }

    function recAsync(ctx: Ctx, elt: Cheerio): PromiseLike<void> {
        let eltId = elt.attr("id")
        if (eltId && ctx.subst.hasOwnProperty(eltId)) {
            let n = ctx.subst[eltId].clone()
            elt.replaceWith(n)
            return recAsync(ctx.subst[eltId].gw_ctx, n)
        }

        if (elt.attr("edit") != null) {
            if (!eltId) error("no id on element marked with 'edit'", ctx, elt);
            if (elt.find("p, ul, ol").length > 0)
                elt.attr("data-editable", "true")
            else
                elt.attr("data-fixture", "true")
        }

        if (elt.is("include")) {
            return includeAsync(ctx, elt, elt.attr("src"))
        }
        return bluebird.each(elt.children().toArray(), ee => recAsync(ctx, h(ee)))
            .then(() => { })
    }
}

function fillContentAsync(cfg: ExpansionConfig) {
    if (cfg.rootFileContent != null)
        return Promise.resolve()
    return gitfs.getTextFileAsync(cfg.rootFile, cfg.ref)
        .then(s => {
            cfg.rootFileContent = s
        })
}

export function expandFileAsync(cfg: ExpansionConfig) {
    return fillContentAsync(cfg)
        // config always takes from master
        .then(() => gitfs.getTextFileAsync(relativePath(cfg.rootFile, "config.json"))
            .then(v => v, e => {
                winston.info("config.json: " + e.message)
                return ""
            }))
        .then(cfText => {
            cfg.pageConfig = JSON.parse(cfText || "{}")
            if (!cfg.pageConfig.langs || !cfg.pageConfig.langs.length)
                cfg.pageConfig.langs = ["en"]
            if (cfg.langs) {
                for (let l of cfg.langs) {
                    if (cfg.pageConfig.langs.indexOf(l) >= 0) {
                        cfg.lang = l
                        break
                    }
                }
            }
            if (!cfg.lang) cfg.lang = cfg.pageConfig.langs[0]
            if (cfg.lang != cfg.pageConfig.langs[0]) {
                cfg.langFileName = relativePath(cfg.rootFile, "lang-" + cfg.lang + ".html")
                return gitfs.getTextFileAsync(cfg.langFileName, cfg.ref)
                    .then(v => v, e => "")
            } else
                return null
        })
        .then(lnText => {
            cfg.langFileContent = lnText
            return expandAsync(cfg)
        })
}
