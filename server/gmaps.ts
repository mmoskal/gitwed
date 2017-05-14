import fs = require("fs")
import path = require("path")
import querystring = require("querystring")
import crypto = require("crypto")
import tools = require("./tools")
import logs = require("./logs")
import gitfs = require("./gitfs")
import winston = require('winston');

export interface MapOptions {
    address: string;
    zoom?: number;
    scale?: number;
    size?: string;
    maptype?: string;
    language?: string;
    markers?: string;
}

export function cleanAddress(addr: string) {
    return addr.replace(/<br>/ig, ", ")
}

export async function getMapsPictureAsync(opts: MapOptions) {
    if (!opts.zoom) opts.zoom = 16
    if (!opts.scale) opts.scale = 2
    if (!opts.size) opts.size = "280x200"
    opts.markers = "color:red|" + cleanAddress(opts.address)
    delete opts.address
    let qs = querystring.stringify(opts)
    let hash = tools.sha256(qs)
    let fn = "map-cache/" + hash + ".png"
    if (!fs.existsSync(fn)) {
        let res = await tools.requestAsync({
            url: "https://maps.googleapis.com/maps/api/staticmap?" + qs + "&key=" + gitfs.config.gmapsKey
        })
        tools.mkdirP("map-cache")
        if (res.statusCode == 200) {
            fs.writeFileSync(fn, res.buffer)
        } else {
            winston.error("bad response from google maps: " + res.statusCode + " / " + res.text, opts)
        }
    }
    return (gitfs.config.cdnPath || "") + "/map-cache/" + hash + ".png"
}
