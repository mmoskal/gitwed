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

async function genEPubAsync(folder: string) {
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

    function addText(fn: string, data: string) {
        zip.file(fn, data, { compression: "DEFLATE" })
    }

    let addProps:SMap<string> = {
        "index.html": `nav`,
    }

    async function addFileAsync(n: string, data: any = null) {
        if (filePresent[n])
            return "f" + filePresent[n]
        if (data === null)
            data = await gitfs.main.getFileAsync(folder + "/" + n, "master")
        let m = mime.lookup(n)
        if (m == "text/html")
            m = "application/xhtml+xml"
        fileNo++
        filePresent[n] = fileNo
        let add = ""
        if (addProps[n])
            add = `properties="${addProps[n]}"`
        opf += `    <item id="f${fileNo}" href="${n}" media-type="${m}" ${add} />\n`
        if (data !== 0) {
            zip.file(n, data, { compression: /image/.test(m) ? "STORE" : "DEFLATE" })
            hash.update(n + hashSep)
            hash.update(data)
        }
        return "f" + filePresent[n]
    }

    async function expandAsync(htmlName: string) {
        let cfg: expander.ExpansionConfig = {
            rootFile: folder + "/" + htmlName,
            ref: "master",
        }

        let res = await expander.expandFileAsync(cfg)
        let h = res.cheerio

        function forEach(sel: string, f: (elt: Cheerio) => void) {
            h(sel).each((i, e) => {
                f(h(e))
            })
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

        function fileOK(fn: string) {
            return !/^[\/\.]/.test(fn)
        }

        let subfiles: string[] = []
        forEach("link[rel=stylesheet]", e => {
            let fn = e.attr("href")
            if (fileOK(fn))
                subfiles.push(fn)
            else
                e.remove()
        })

        h("script").remove()

        forEach("img", e => {
            let fn = e.attr("src")
            if (!e.attr("alt"))
                e.attr("alt", fn)
            if (!fileOK(fn)) {
                e.remove()
            } else {
                subfiles.push(fn)
                if (e.hasClass("cover")) {
                    addProps[fn] = "cover-image"
                }
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
            let subpages: string[] = []
            forEach("a", e => {
                let href = e.attr("href")
                if (/^[^\/]+$/.test(href)) {
                    subpages.push(href)
                }
            })
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
    app.get("/api/epub", (req, res) => {
        if (!req.appuser)
            tools.throwError(402)
        let folder = req.query["folder"] || "book"
        if (!/^[\w\.\-]+$/i.test(folder))
            tools.throwError(400)
        if (folder.indexOf("private") >= 0)
            tools.throwError(403)
        genEPubAsync(folder)
            .then(buf => {
                res.contentType("application/epub+zip")
                res.header("Content-Disposition",
                    `attachment; filename="${folder}.epub"`);
                res.send(buf)
            })
    })
}