import express = require('express');
import mime = require('mime');
import crypto = require('crypto');
import fs = require('fs');
import JSZip = require("jszip");
import expander = require('./expander')
import gitfs = require('./gitfs')
import tools = require('./tools')
import bluebird = require('bluebird')
import auth = require('./auth')
import winston = require('winston')
import logs = require('./logs')
import routing = require('./routing')
import img = require('./img')

interface EPubOptions {
    folder: string;
    isKindle: boolean;
}


const metaInf = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`

const opfHead = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf"
         xmlns:dc="http://purl.org/dc/elements/1.1/"
         unique-identifier="bookid"
         version="3.0">
  <metadata xmlns:opf="http://www.idpf.org/2007/opf"
            xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title></dc:title>
    <dc:creator></dc:creator>
    <dc:subject></dc:subject>
    <dc:description></dc:description>
    <dc:publisher></dc:publisher>
    <dc:date></dc:date>
    <dc:source></dc:source>
    <dc:relation></dc:relation>
    <dc:coverage></dc:coverage>
    <dc:rights></dc:rights>
    <dc:identifier id="bookid">urn:uuid:@UUID@</dc:identifier>
    <dc:language></dc:language>
    <meta name="cover" content="file_cover" />
    <meta property="dcterms:modified">@DATE@</meta>
  </metadata>
  <manifest>
    <item id="toc" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
`

const tocHead = `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:@UUID@"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>@TITLE@</text></docTitle>
  <navMap>
`

function genUUID(b: Buffer) {
    // xxxxxxxx-xxxx-Mxxx-Nxxx-xxxxxxxxxxxx
    let h = b.toString("hex")
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-4" + h.slice(12, 15) + "-a" + h.slice(15, 18) + "-" + h.slice(18, 30)
}

function xmlQ(s: string) {
    return tools.htmlQuote(s)
}


function fileOK(fn: string) {
    return fn && !/^[\/\.]/.test(fn)
}

function resolveHref(s: string): string {
    if (!s) return s
    let m = /(.*)(#.*)/.exec(s)
    if (m) {
        return resolveHref(m[1]) + m[2]
    }
    if (/^https?:/.test(s))
        return s
    if (!/\.html$/.test(s)) s += ".html"
    return s
}

// TODO handle mising files!

function runExpanderAsync(fn: string) {
    let cfg: expander.ExpansionConfig = {
        rootFile: fn,
        ref: "master",
    }
    return expander.expandFileAsync(cfg)
}

export interface TocProps {
    title: string;
    author: string;
    image: string;
    href: string;
    flags: string;
}

async function genTOCAsync(folder: string) {
    async function getPropsAsync(htmlName: string): Promise<TocProps> {
        let res = await runExpanderAsync(folder + "/" + htmlName)
        let h = res.cheerio
        let title = h(".title").first().text().trim()
        let author = h(".author").first().text().trim()
        let image = h("img").first().attr("src")
        let flags = h("div[id=gw-meta-flags]").text() || ""
        if (/no-toc-img/i.test(flags))
            image = null
        /*
        if (!image)
             image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8vyL6PwAHswMDJopgsQAAAABJRU5ErkJggg=="
            //image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="
        */
        return {
            title,
            author,
            image,
            href: htmlName,
            flags
        }
    }

    let res = await runExpanderAsync(folder + "/index.html")
    let h = res.cheerio

    let subpages: string[] = []
    res.forEach("a", e => {
        let href = e.attr("href")
        if (fileOK(href))
            subpages.push(resolveHref(href))
    })
    let rr: TocProps[] = []
    for (let fn of subpages) {
        rr.push(await getPropsAsync(fn))
    }
    return rr
}

async function genEPubAsync(opts: EPubOptions) {
    const folder = opts.folder
    const zip = new JSZip()
    const hash = crypto.createHash("sha256")
    const hashSep = "VtoFQZQyyrpuGVRBiFF3oTxpyDcNO7JBIJyaH"

    zip.file("mimetype", "application/epub+zip", { compression: "STORE" })
    zip.file("META-INF/container.xml", metaInf, { compression: "DEFLATE" })

    const filePresent: SMap<number> = {}
    let fileNo = 0
    let htmlNo = 0

    let opf = ""
    let spine = `</manifest>\n<spine toc="toc">\n`
    let close = `</spine>\n</package>\n`
    let toc = tocHead
    let tocHTML = `<nav id="tocnav" style="display:none" epub:type="toc"><ol>\n`

    let title = ""
    let date = ""
    let indexCheerio: CheerioStatic = null

    let subpages: string[] = []

    function addText(fn: string, data: string) {
        zip.file(fn, data, { compression: "DEFLATE" })
    }

    let addProps: SMap<string> = {
        "index.html": `nav`,
    }

    async function addFileAsync(n: string, data: any = null) {
        if (filePresent[n])
            return "f" + filePresent[n]
        if (data === null)
            data = await gitfs.findRepo(folder).getFileAsync(folder + "/" + n, "master")
        let m = mime.lookup(n)
        if (m == "text/html")
            m = "application/xhtml+xml"
        fileNo++
        filePresent[n] = fileNo
        let add = ""
        if (addProps[n])
            add = `properties="${addProps[n]}"`

        if (m == "image/jpeg" || m == "image/png") {
            let tmp = await img.resizeAsync(data, { maxWidth: /cover/.test(add) ? 2000 : 1000 })
            data = tmp.buffer
        }

        opf += `    <item id="f${fileNo}" href="${n}" media-type="${m}" ${add} />\n`
        if (data !== 0) {
            zip.file(n, data, { compression: /image/.test(m) ? "STORE" : "DEFLATE" })
            hash.update(n + hashSep)
            hash.update(data)
        }
        return "f" + filePresent[n]
    }

    async function expandAsync(htmlName: string) {
        const res = await runExpanderAsync(folder + "/" + htmlName)
        const h = res.cheerio
        const forEach = res.forEach

        h("body").removeClass("web")

        let htmlIdx = subpages.indexOf(htmlName)
        let navTmpl = h("#epub-prev-next")
        if (htmlIdx != -1 && navTmpl.length) {
            let tmpl =
                navTmpl.html()
                    .replace(/^\s*<!--/, "")
                    .replace(/-->\s*$/, "")
            if (tmpl) {
                let tt = h(tmpl)
                if (htmlIdx == 0)
                    tt.find(".prev").addClass("disabled")
                else
                    tt.find(".prev").attr("href", subpages[htmlIdx - 1])
                if (htmlIdx + 1 >= subpages.length)
                    tt.find(".next").addClass("disabled")
                else
                    tt.find(".next").attr("href", subpages[htmlIdx + 1])
                tt.find(".idx").attr("href", "index.html#toc-pre")

                let author = h("h2.author")
                if (!author.length) author = h("h1")
                author.first().after(tt.clone())

                //h("h1").first().parent().append(tt.clone())
            }
        }

        if (!opf) {
            opf = opfHead
                .replace(/<dc:(\w+)><\/dc:[^<>]+>/g, (f, id) => {
                    let v = h("div[id=gw-meta-" + id + "]").text().trim()
                    if (!v) return ""
                    return "<dc:" + id + ">" + xmlQ(v) + "</dc:" + id + ">"
                })
            title = h("div[id=gw-meta-title]").text().trim()
            date = h("div[id=gw-meta-date]").text().trim()
        }

        let subfiles: string[] = []
        forEach("link[rel=stylesheet]", e => {
            let fn = e.attr("href")
            if (opts.isKindle) {
                fn = fn.replace("epub", "kindle")
                e.attr("href", fn)
            }
            if (fileOK(fn))
                subfiles.push(fn)
            else
                e.remove()
        })

        h("script").remove()

        forEach("sup", e => {
            let par = e.parent()
            let t = e.text().trim()
            let m = /^\s*(\d+)\s*$/.exec(t)
            if (m) {
                let id = parseInt(m[1])
                if (par.is("p") && /^\s*<sup>/.test(par.html())) {
                    par.attr("id", "foot" + id)
                    e.replaceWith(`<a epub:type="footnote" class="footback" href="#footback${id}"><sup>${id}</sup></a>`)
                } else {
                    e.replaceWith(`<a epub:type="noteref" class="foot" id="footback${id}" href="#foot${id}"><sup>${id}</sup></a>`)
                }
            } else {
                t = t.toLowerCase()
                if (t == "end") {
                    e.replaceWith(`<span class="end"><img src="img/end.png" alt="The End."></span>`)
                }
            }
        })

        forEach("img", e => {
            let fn = e.attr("src")
            if (!e.attr("alt"))
                e.attr("alt", fn)
            if (!fileOK(fn)) {
                e.remove()
                return
            } else if (/^data:/.test(fn)) {
                // OK
            } else {
                subfiles.push(fn)
                if (e.hasClass("cover")) {
                    addProps[fn] = "cover-image"
                }
            }
            let isSmall =
                parseInt(e.attr("width")) < 350 &&
                parseInt(e.attr("height")) < 350
            if (isSmall)
                e.addClass("small")
            e.removeAttr("width")
            e.removeAttr("height")
            let par = e.parent()
            if (!par.is("div"))
                return

            let n = e.next("*")
            let tmp = h(`<figure></figure>`)
            if (isSmall)
                tmp.addClass("small")
            e.replaceWith(tmp)
            tmp.append(e)
            if (n.is("figcaption")) {
                tmp.append(n)
            }
        })

        for (let fn of subfiles) {
            await addFileAsync(fn)
        }

        forEach("*", e => {
            Object.keys(e[0].attribs).forEach(k => {
                if (/^data-/.test(k))
                    e.removeAttr(k)
            })
        })

        forEach("a", e => {
            let href = e.attr("href")
            if (fileOK(href)) {
                href = resolveHref(href)
                e.attr("href", href)
                if (htmlName == "index.html") {
                    subpages.push(href)
                }
            }
        })

        let data: any = h.xml()
        if (htmlName == "index.html") {
            data = 0
            indexCheerio = h
        }

        let id = await addFileAsync(htmlName, data)
        spine += `    <itemref idref="${id}" />\n`

        let tit0 = h("h1").first().text().trim()
        htmlNo++
        toc += `
    <navPoint id="navpoint-${htmlNo}" playOrder="${htmlNo}">
      <navLabel><text>${xmlQ(tit0)}</text></navLabel>
      <content src="${htmlName}" />
    </navPoint>
`
        tocHTML += `
    <li><a href="${htmlName}">${xmlQ(tit0)}</a></li>
`

        if (htmlName == "index.html") {
            for (let fn of subpages) {
                await expandAsync(fn)
            }
        }
    }

    await expandAsync("index.html")

    let fullOpf = opf + spine + close
    hash.update(fullOpf)
    hash.update(toc)

    let uuid = genUUID(hash.digest())
    fullOpf = fullOpf.replace("@UUID@", uuid)
    fullOpf = fullOpf.replace("@DATE@", date + "T12:00:00Z")

    toc += `</navMap>\n</ncx>`
    toc = toc.replace("@UUID@", uuid)
    toc = toc.replace("@TITLE@", xmlQ(title))

    addText("content.opf", fullOpf)
    addText("toc.ncx", toc)

    tocHTML += "</ol></nav>"

    indexCheerio("body").prepend(tocHTML)
    addText("index.html", indexCheerio.xml())

    return await zip.generateAsync({ type: "nodebuffer" })
}

export function init(app: express.Express) {
    function getFolder(req: express.Request): string {
        if (!req.appuser)
            tools.throwError(402)
        let folder = req.query["folder"]
        if (!folder || !/^[\w\.\-]+$/i.test(folder))
            tools.throwError(400)
        if (folder.indexOf("private") >= 0)
            tools.throwError(403)
        return folder
    }

    app.get("/api/epubtoc", (req, res) => {
        genTOCAsync(getFolder(req))
            .then(toc => {
                res.json({
                    toc: toc
                })
            })
    })

    app.get("/api/epub", (req, res) => {
        let folder = getFolder(req)
        let isKindle = !!req.query["kindle"]
        genEPubAsync({
            folder,
            isKindle
        })
            .then(buf => {
                res.contentType("application/epub+zip")
                res.header("Content-Disposition",
                    `attachment; filename="${folder}${isKindle ? "-kindle" : ""}.epub"`);
                res.send(buf)
            })
    })
}