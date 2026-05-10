import fs = require("fs")
import os = require("os")
import path = require("path")
import sharp = require("sharp")
import { resizeAsync } from "./img"

describe("resizeAsync()", () => {
    let cwd: string
    let tmpDir: string

    beforeEach(() => {
        cwd = process.cwd()
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitwed-img-"))
        process.chdir(tmpDir)
    })

    afterEach(() => {
        process.chdir(cwd)
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it("resizes images and reads the cached result", async () => {
        const source = await sharp({
            create: {
                width: 4,
                height: 2,
                channels: 3,
                background: "#ff0000",
            },
        })
            .png()
            .toBuffer()

        const first = await resizeAsync(source, { maxWidth: 2 })
        const second = await resizeAsync(source, { maxWidth: 2 })

        expect(first.ext).toBe("png")
        expect(first.width).toBe(2)
        expect(first.height).toBe(1)
        expect(second).toMatchObject({
            ext: first.ext,
            width: first.width,
            height: first.height,
        })
        expect(second.buffer.equals(first.buffer)).toBe(true)
    })
})
