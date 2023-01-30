import crypto = require("crypto")
import fs = require("fs")
import gitfs = require("./gitfs")
import tools = require("./tools")
import bluebird = require("bluebird")
import winston = require("winston")
import sharp = require("sharp")

export interface ImgOptions {
    maxWidth: number
    maxHeight?: number
    quality?: number
}

export interface ImgResult {
    ext: string // jpg or png
    width: number
    height: number
    buffer: Buffer
}

function constrainSize(w: number, h: number, maxW: number, maxH: number) {
    let scale = Math.min(maxW / w, maxH / h)
    if (scale < 1) {
        w = Math.floor(scale * w)
        h = Math.floor(scale * h)
    }
    return {
        w,
        h,
    }
}

export async function resizeAsync(
    img: Buffer,
    opts: ImgOptions
): Promise<ImgResult> {
    if (opts.maxWidth && !opts.maxHeight) opts.maxHeight = opts.maxWidth
    if (!opts.quality) opts.quality = 80

    let h = crypto.createHash("sha256")
    h.update(img)
    h.update(JSON.stringify(opts))
    let hash = h.digest("hex").toLowerCase()
    let fn = "img-cache/" + hash + ".json"

    if (!fs.existsSync(fn)) {
        let meta = await sharp(img).metadata()
        let ext = meta.format == "png" ? "png" : "jpg"
        if (meta.width <= opts.maxWidth && meta.height <= opts.maxHeight)
            return {
                ext,
                width: meta.width,
                height: meta.height,
                buffer: img,
            }

        let sz = constrainSize(
            meta.width,
            meta.height,
            opts.maxWidth,
            opts.maxHeight
        )

        let sh = sharp(img).resize(sz.w, sz.h)

        if (meta.format == "png") sh = sh.png()
        else sh = sh.jpeg({ quality: opts.quality })

        let buf = await sh.toBuffer()

        let res: ImgResult = {
            ext,
            width: sz.w,
            height: sz.h,
            buffer: null,
        }

        let tmp = tools.clone(res)
        tmp.buffer = buf.toString("base64") as any
        tools.mkdirP("img-cache")
        fs.writeFileSync(fn, JSON.stringify(tmp, null, 1))

        winston.info(`create ${fn} (${sz.w} x ${sz.h}) .${ext}`)

        res.buffer = buf
        return res
    } else {
        let res: ImgResult = JSON.parse(fs.readFileSync(fn, "utf8"))
        res.buffer = Buffer.from(res.buffer as any, "base64")
        return res
    }
}
