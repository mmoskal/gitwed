import express = require('express');
import mime = require('mime');
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

function genEPubAsync(folder: string) {
    const zip = new JSZip()
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" })
    zip.file("META-INF/container.xml", metaInf, { compression: "DEFLATE" })
    return zip.generateAsync({ type: "nodebuffer" })
}

export function init(app: express.Express) {
    app.get("/api/epub", (req, res) => {
        if (!req.appuser)
            tools.throwError(402)
        let folder = req.query["folder"] || "book"
        genEPubAsync(folder)
            .then(buf => {
                res.contentType("application/epub+zip")
                res.header("Content-Disposition",
                    `attachment; filename="${folder}.epub"`);
                res.send(buf)
            })
    })
}