import cheerio = require("cheerio")
import gitfs = require('./gitfs')
import auth = require('./auth')
import events = require('./events')
import tools = require('./tools')
import rest = require('./rest')
import * as bluebird from "bluebird";
import * as winston from "winston";

let htmlparser2 = require("htmlparser2")

function toHTML(e: CheerioStatic | Cheerio) {
    return e.html().replace(/&#x([0-9a-f]{1,6});/ig, (entity, match) => {
        let code = parseInt(match, 16)
        if (code < 0x80) return entity
        return String.fromCodePoint(code)
    })
}

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

export interface Pos {
    filename: string;
    startIdx: number;
    length: number;
}

export interface PageConfig {
    langs?: string[];
    users?: string[];
    templates?: SMap<string>
    custom404?: string;
    center?: string;
    epub?: boolean;
    private?: boolean;
}

export interface ExpansionConfig {
    rootFile: string;
    origHref?: string;
    origQuery?: SMap<string>;
    ref?: string;
    appuser?: string;
    rootFileContent?: string;
    lang?: string;
    langs?: string[];
    langFileName?: string;
    langFileContent?: string;
    pageConfig?: PageConfig;
    hasWritePerm?: boolean;
    vars?: SMap<string>;
    contentOverride?: SMap<string>;
    eventInfo?: events.FullEvent;
    centerInfo?: events.Center;
}

export function relativePath(curr: string, newpath: string) {
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

export function cleanHtmlFragment(frag: string) {
    frag = frag.replace(/\r/g, "")
    frag = frag.replace(/(^\n*)|(\n*$)/g, "\n")
    let h = cheerio.load(frag, cheerioOptions)

    h("*").each((idx, ee) => {
        let e = h(ee)
        let attrs: SMap<string> = ee.attribs as any
        for (let k of Object.keys(ee.attribs)) {
            let m = /^data-gw-orig-(.*)/.exec(k)
            if (m) {
                let v = attrs[k]
                if (v) {
                    attrs[m[1]] = v
                    delete attrs[k]
                }
            }
        }
    })

    return toHTML(h)
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
    return toHTML(h)
}


function canBeCdned(v: string, canHaveRelativeLinks = false) {
    if (!v) return false
    if (/^[\w-]+:\/\//.test(v)) return false
    if (/^\/(gwcdn|common)\//.test(v)) return true
    if (/\.(png|jpe?g|ico)$/i.test(v)) return true
    if (canHaveRelativeLinks && !/(^|\/)cdn\//.test(v)) return false
    return true
}

export const replicatePictureSource = (ee: Cheerio, replicate: (url: string) => Promise<string>): Promise<void>[] => {
    // special case for <picture><source srcset="..." /></picture>
    const srcset = ee.attr("srcset")
    if (!srcset) return []
    const newSrcset = srcset.split(",").reduce((acc, mediaData) => {
        const mediaParams = mediaData.trim().split(" ")
        const v = mediaParams[0]
        if (!canBeCdned(v, false)) return acc

        acc.push(replicate(v).then(r => {
            mediaParams[0] = r
            return mediaParams.join(" ")
        }))
        return acc
    }, [])

    return [Promise.all(newSrcset).then(updatedSrcset => {
        ee.attr("srcset", updatedSrcset.join(", "))
        ee.attr("data-gw-orig-srcset", srcset)
    })]
}

function expandAsync(cfg: ExpansionConfig) {
    let filename = cfg.rootFile
    let fileContent = cfg.rootFileContent

    let hLoc = cfg.langFileContent ? cheerio.load(cfg.langFileContent, cheerioOptions) : null
    let h = cheerio.load(fileContent, cheerioOptions)

    let idToPos: SMap<Pos> = {}
    let allFiles: SMap<string> = {}
    let trees: SMap<Promise<gitfs.TreeEntry[]>> = {}
    let langMap: SMap<string> = {}

    setLocations(h.root(), filename, fileContent)

    function forEach(sel: string, f: (elt: Cheerio) => void) {
        h(sel).each((i, e) => {
            f(h(e))
        })
    }

    return recAsync({ filename, subst: {}, fileContent }, h.root())
        .then(() => {
            h("group, if-edit").each((i, e) => {
                h(e).replaceWith(e.childNodes)
            })
            forEach("[gw-pos]", ee => {
                let m = /(.*)@(\d+)-(\d+)/.exec(ee.attr("gw-pos"))
                let id = ee.attr("edit") || ee.attr("id")
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
                hLoc("[data-gw-id]").each((i, e) => {
                    let ee = hLoc(e)
                    let id = ee.attr("data-gw-id")
                    langMap[id] = toHTML(ee)
                })
                h("[data-gw-id]").each((i, e) => {
                    let ee = h(e)
                    let id = ee.attr("data-gw-id")
                    if (langMap[id]) {
                        ee.html(langMap[id])
                    }
                })
            }

            forEach("li a[href]", ee => {
                let hr = ee.attr("href")
                let m = /\/([^\/]+)\.html$/.exec(cfg.rootFile)
                let here = m ? m[1] : "???"
                if (hr == here) {
                    ee.parent().addClass("active")
                } else {
                    ee.parent().removeClass("active")
                }
            })
        })
        .then(cdnRewriteAsync)
        .then(() => {
            return {
                allFiles,
                idToPos,
                langMap,
                cheerio: h,
                forEach,
                html: toHTML(h)
            }
        })

    function getTreeAsync(repo: gitfs.GitFs, path: string) {
        if (trees[path])
            return trees[path]
        return (trees[path] =
            repo.getTreeAsync(path, cfg.ref)
                .then(ents => {
                    if (!ents)
                        winston.debug("no such tree: " + path + " in " + cfg.ref)
                    return ents
                }))
    }

    function replUrlAsync(url: string) {
        let resolved = relativePath(cfg.rootFile, url)
        let spl = gitfs.splitName(resolved)
        let ext = spl.name.replace(/.*\./, ".")
        if (spl.parent == "/gwcdn") {
            let sha = gitfs.gwcdnByName[spl.name]
            if (!sha)
                winston.info("no such file (GWCDN): " + resolved + " in " + cfg.ref)
            return Promise.resolve(!sha ? url : gitfs.config.cdnPath + "/" + spl.name + "-" + sha + ext)
        }
        let repo = gitfs.findRepo(spl.parent)
        //winston.info(`repl: ${url} par=${spl.parent} r=${repo.id}`)
        return getTreeAsync(repo, spl.parent)
            .then(ents => {
                if (!ents)
                    return url
                let e = ents.find(x => x.name == spl.name)
                if (e) {
                    let pref = repo.id == "main" ? "" : repo.id + "/"
                    return gitfs.config.cdnPath + "/" + pref + spl.name + "-" + e.sha + ext
                } else {
                    winston.info("no such file: " + resolved + " in " + cfg.ref)
                    return url
                }
            })
    }

    function metaRewrite() {
        let clean = (s: string) => (s || "").replace(/\s+/g, " ").trim()
        let metas: SMap<string> = {
            title: clean(h("#gw-meta-title").text() || h("title").text() || h("h1").first().text())
        }
        let commonMeta = ["description", "keywords", "copyright", "author"]
        for (let m of commonMeta) {
            metas[m] = clean(h("#gw-meta-" + m).text() || h("meta[name='" + m + "']").attr("content"))
        }

        h("title").text(metas["title"])

        let metaMap: SMap<string> = {
            'twitter:title': 'title',
            'twitter:description': 'description',
            'og:title': 'title',
            'og:description': 'description',
        }
        for (let x of commonMeta)
            metaMap[x] = x
        for (let k of Object.keys(metaMap)) {
            let e = h(`meta[name='${k}']`)
            if (!e.length)
                e = h(`meta[property='${k}']`)
            if (!e.length) continue
            if (!e.attr("content"))
                e.attr("content", metas[metaMap[k]])
        }

        h("meta[http-equiv='Content-Language']").attr("content", cfg.lang)

        if (cfg.lang && cfg.langs.length > 1) {
            let currPath = cfg.origHref || cfg.rootFile
            let ht = cfg.langs.map(lang => {
                let setlang = currPath + (currPath.indexOf("?") >= 0 ? "&" : "?") + "lang="
                let href = setlang + lang
                return `    <link rel="alternate" href="${href}" hreflang="${lang}" />\n`
            }).join("") +
                `    <link rel="alternate" href="${currPath}" hreflang="x-default" />\n`
            h("head").append(
                `\n    <!-- links to alternate langauges for search engines -->\n` +
                ht)
        }
    }

    function cdnRewriteAsync() {
        let promises: Promise<void>[] = []
        let replIdx = 0

        metaRewrite()

        h("rest").each((idx, e) => {
            promises.push(rest.expandAsync(h(e)))
        })

        if (gitfs.config.justDir && !gitfs.config.cdnPath)
            return Promise.all(promises).then(() => {
            })

        let repl = (e: CheerioElement, attrName: string, mayHaveRelativeLinks = false) => {
            let ee = h(e)
            let v = ee.attr(attrName)
            if (!v) return
            if (!canBeCdned(v, mayHaveRelativeLinks)) return
            promises.push(replUrlAsync(v).then(r => {
                //winston.debug("repl: " + v + " -> " + r)
                if (r != v) {
                    ee.attr(attrName, r)
                    ee.attr("data-gw-orig-" + attrName, v)
                }
            }))
        }

        // used by some plugins
        h("[data-background]").each((idx, e) => {
            repl(e, "data-background", true)
        })

        h("img, audio, video, track").each((idx, e) => {
            repl(e, "src")
            if (e.tagName != "img")
                repl(e, "poster")
        })
        h("source").each((_, e) => {
            replicatePictureSource(h(e), replUrlAsync).forEach(res => promises.push(res))
        })
        h("script").each((idx, e) => {
            repl(e, "src", true)
        })
        h("link").each((idx, e) => {
            let ee = h(e)
            let rels = (ee.attr("rel") || "").split(/\s+/)
            if (rels.indexOf("stylesheet") >= 0)
                repl(e, "href", true)
            if (rels.indexOf("icon") >= 0 || rels.indexOf("apple-touch-icon") >= 0)
                repl(e, "href")
        })
        h("meta").each((idx, e) => {
            let ee = h(e)
            let p = ee.attr("property") || ee.attr("name")
            if (/(TileImage|:image)$/.test(p))
                repl(e, "content")
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

        return Promise.all(promises).then(() => {
        })
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

        let setloc = (x: Cheerio) => {
            let start = x[0].startIndex
            let end = mapping[start + ""]
            if (fileContent[start] == "<") {
                while (start < fileContent.length && fileContent[start] != ">")
                    start++;
                start++;
            }
            //console.log(`${ch.tagName}: "${fileContent.slice(start, end)}"`)
            x.attr("gw-pos", filename + "@" + start + "-" + (end - start))
        }

        if (e.attr("edit")) setloc(e)
        e.find("[edit]").each((i, ch) => setloc(h(ch)))
    }

    function includeAsync(ctx: Ctx, e: Cheerio, filename: string) {
        filename = relativePath(ctx.filename, filename)
        return gitfs.findRepo(filename).getTextFileAsync(filename, cfg.ref)
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
            eltId = elt.attr("edit") || eltId
            if (!eltId) error("no id on element marked with 'edit'", ctx, elt);
            if (cfg.contentOverride && cfg.contentOverride[eltId]) {
                elt.html(cfg.contentOverride[eltId])
            }
            if (elt.find("p, ul, ol, h1, h2, h3, h4, h5, h6").length > 0)
                elt.attr("data-editable", "true")
            else
                elt.attr("data-fixture", "true")
        }

        let tag = elt[0].tagName
        if (elt.length > 1) tag = ""

        if (tag == "include") {
            return includeAsync(ctx, elt, elt.attr("src"))
        }

        if (tag == "if-edit" && !cfg.appuser) {
            elt.replaceWith("")
            return Promise.resolve()
        }

        if (tag == "event-list") {
            let q = tools.clone(cfg.origQuery || {})
            tools.copyFields(q, elt[0].attribs)
            q["center"] = q["center"] || cfg.pageConfig.center
            return events.queryEventsAsync(q, cfg.lang)
                .then(r => {
                    let html = tools.expandTemplateList(elt.html(), r.events)
                    elt.replaceWith(html)
                })
        }

        if (tag == "lang-list") {
            let deflTempl: string = null
            let templ = elt.html().replace(/<current>([^]*)<\/current>/, (f, c) => {
                deflTempl = c
                return ""
            })
            if (deflTempl == null) deflTempl = templ
            let ht = cfg.langs.map(lang => {
                let currPath = cfg.origHref || cfg.rootFile
                let setlang = currPath + (currPath.indexOf("?") >= 0 ? "&" : "?") + "setlang="
                let isCurr = lang == cfg.lang
                let href = setlang + lang
                let full = tools.getLocale(lang).lang
                return tools.expandTemplate(isCurr ? deflTempl : templ, {
                    lang,
                    LANG: lang.toUpperCase(),
                    href,
                    full,
                    current: isCurr ? "current" : ""
                })
            }).join("\n")
            if (cfg.langs.length <= 1) ht = ""
            elt.replaceWith(ht)
            return Promise.resolve()
        }

        let arr = elt.length > 1 ? elt.toArray() : elt.children().toArray()
        return bluebird.each(arr, ee => recAsync(ctx, h(ee)))
            .then(() => { })
    }
}

function fillContentAsync(cfg: ExpansionConfig) {
    if (cfg.rootFileContent != null)
        return Promise.resolve()
    return gitfs.findRepo(cfg.rootFile).getTextFileAsync(cfg.rootFile, cfg.ref)
        .then(s => {
            cfg.rootFileContent = s
        })
}

export function pageConfigPath(page: string) {
    let m = /^\/?([^\/]+)/.exec(page)
    if (!m)
        return null
    let dir = m[1]
    if (dir == "favicon.ico")
        dir = "common"
    return "/" + dir + "/config.json"
}

export function getPageConfigAsync(page: string): Promise<PageConfig> {
    let m = /^\/?center-(\w+)/.exec(page)
    if (m)
        return Promise.resolve({ center: m[1] })

    let path = pageConfigPath(page)
    if (!path)
        return Promise.reject(new Error("Invalid page path."))
    // config always taken from master
    return Promise.resolve()
        .then(() => gitfs.findRepo(path).getTextFileAsync(path)
            .then(v => v, e => {
                return Promise.reject(new Error("Missing config.json: " + e.message))
            }))
        .then(async (cfText) => {
            let cfg = JSON.parse(cfText) as PageConfig
            if (cfg.center && gitfs.events) {
                let c = await events.getCenterAsync(cfg.center)
                if (c)
                    cfg.users = (c.users || []).slice()
            }
            return cfg
        })
}

export async function hasWritePermAsync(appuser: string, page: string) {
    let m = /^\/?center-(\w+)/.exec(page)
    if (m) {
        let c = await events.getCenterAsync(m[1])
        if (c)
            return auth.hasWritePermAsync(appuser, c.users)
    }

    let cfg = await getPageConfigAsync(page)
    return auth.hasWritePermAsync(appuser, cfg.users)
}

export async function expandFileAsync(cfg: ExpansionConfig) {
    await fillContentAsync(cfg)
    let pcfg = await getPageConfigAsync(cfg.rootFile)
    cfg.pageConfig = pcfg
    let plangs = cfg.pageConfig.langs
    let avlangs = plangs

    let centerId = pcfg.center
    if (cfg.eventInfo) centerId = cfg.eventInfo.center

    if (centerId)
        cfg.centerInfo = await events.getCenterAsync(centerId)

    if (!plangs || !plangs.length)
        cfg.pageConfig.langs = plangs = ["en"]

    if (cfg.eventInfo && !cfg.appuser) {
        avlangs = events.getLangs(cfg.eventInfo)
    } else if (cfg.centerInfo) {
        avlangs = events.getLangs(cfg.centerInfo)
    } else {
        avlangs = plangs
    }

    if (cfg.langs) {
        for (let l of cfg.langs) {
            if (avlangs.indexOf(l) >= 0) {
                cfg.lang = l
                break
            }
        }
    }

    if (!cfg.lang) {
        // if no match, default to en (if available), not first langauge in the list
        cfg.lang = avlangs.indexOf("en") >= 0 ? "en" : avlangs[0]
    }

    if (cfg.lang != plangs[0]) {
        cfg.langFileName = relativePath(cfg.rootFile, "lang-" + cfg.lang + ".html")
        cfg.langFileContent = await gitfs.findRepo(cfg.langFileName).getTextFileAsync(cfg.langFileName, cfg.ref)
            .then(v => v, e => "")
    }

    cfg.hasWritePerm = await auth.hasWritePermAsync(cfg.appuser, cfg.pageConfig.users)
    if (!cfg.vars) cfg.vars = {}

    await events.addVarsAsync(cfg)

    if (cfg.eventInfo) {
        pcfg.center = cfg.eventInfo.center
        let cent = await events.getCenterAsync(cfg.eventInfo.center)
        cfg.hasWritePerm = cfg.hasWritePerm || await auth.hasWritePermAsync(cfg.appuser, cent.users)
    }

    let pageInfo = {
        user: cfg.appuser || null,
        lang: cfg.lang,
        langFileCreated: !!cfg.langFileContent,
        availableLangs: avlangs,
        isDefaultLang: avlangs[0] == cfg.lang,
        path: cfg.rootFile,
        isEditable: cfg.hasWritePerm && cfg.ref == "master",
        ref: cfg.ref,
        eventInfo: cfg.appuser ? cfg.eventInfo : null,
        centerInfo: cfg.appuser ? cfg.centerInfo : null,
        center: pcfg.center,
        epub: !!cfg.pageConfig.epub,
    }
    cfg.vars["pageInfo"] = "\nvar gitwedPageInfo = " +
        JSON.stringify(pageInfo, null, 4) + ";\n"
    cfg.vars["gw_lang"] = cfg.lang
    cfg.langs = avlangs

    let r = await expandAsync(cfg)

    if (!cfg.contentOverride) cfg.contentOverride = {}

    r.html = r.html.replace(/@@(\w+)@@/g, (f, v) =>
        cfg.vars[v] || cfg.contentOverride[v] || "")

    return r
}
