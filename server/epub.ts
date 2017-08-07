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
         version="2.0">
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
  </metadata>
  <manifest>
    <item id="toc" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
`

const tocHead = `<?xml version="1.0"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN"
          "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
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
    let guide = `</spine>\n<guide>\n`
    let close = `</guide>\n</package>\n`
    let toc = tocHead

    let title = ""

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
        opf += `    <item id="f${fileNo}" href="${n}" media-type="${m}" />\n`
        zip.file(n, data, { compression: /image/.test(m) ? "STORE" : "DEFLATE" })
        hash.update(n + hashSep)
        hash.update(data)
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
                .replace(/<dc:(\w+)><\//g, (f, id) => {
                    return "<dc:" + id + ">" + xmlQ(h("div[id=gw-meta-" + id + "]").text().trim()) + "</"
                })
            title = h("div[id=gw-meta-title]").text().trim()
        }

        let subfiles: string[] = []
        forEach("link[rel=stylesheet]", e => {
            let fn = e.attr("href")
            subfiles.push(fn)
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

        let id = await addFileAsync(htmlName, res.cheerio.xml())
        spine += `    <itemref idref="${id}" />\n`

        let tit0 = h("h1").first().text().trim()
        htmlNo++
        toc += `
    <navPoint id="navpoint-${htmlNo}" playOrder="${htmlNo}">
      <navLabel><text>${xmlQ(tit0)}</text></navLabel>
      <content src="${htmlName}" />
    </navPoint>
`;

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

    let fullOpf = opf + spine + guide + close
    hash.update(fullOpf)
    hash.update(toc)

    let uuid = genUUID(hash.digest())
    fullOpf = fullOpf.replace("@UUID@", uuid)

    toc += `</navMap>\n</ncx>`
    toc = toc.replace("@UUID@", uuid)
    toc = toc.replace("@TITLE@", xmlQ(title))

    zip.file("content.opf", fullOpf, { compression: "DEFLATE" })
    zip.file("toc.ncx", toc, { compression: "DEFLATE" })

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