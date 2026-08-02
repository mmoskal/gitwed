import sharp = require("sharp")
import {
    imageBasename,
    imageDirectoryForPage,
    replacementImagePath,
    validateImageAsync,
} from "./image-upload"

function statusCode(error: any) {
    return error && error.statusCode
}

describe("image upload validation", () => {
    let png: Buffer
    let jpeg: Buffer

    beforeAll(async () => {
        const source = sharp({
            create: {
                width: 2,
                height: 2,
                channels: 3,
                background: "#123456",
            },
        })
        png = await source.png().toBuffer()
        jpeg = await source.jpeg().toBuffer()
    })

    it("accepts valid PNG and JPEG data with matching extensions", async () => {
        const uploaded = await validateImageAsync(png.toString("base64"), "png")
        const replaced = await validateImageAsync(
            jpeg.toString("base64"),
            "site/img/photo.JPEG",
            true
        )

        expect(uploaded.ext).toBe(".png")
        expect(replaced.ext).toBe(".jpg")
    })

    it("rejects extension/content mismatches and malformed data", async () => {
        await expect(
            validateImageAsync(png.toString("base64"), "jpg")
        ).rejects.toMatchObject({ statusCode: 415 })
        await expect(validateImageAsync("not base64", "png")).rejects.toMatchObject(
            { statusCode: 400 }
        )
        await expect(
            validateImageAsync(Buffer.from("plain text").toString("base64"), "png")
        ).rejects.toMatchObject({ statusCode: 415 })
    })

    it("derives normal upload and replacement paths", () => {
        expect(imageDirectoryForPage("/site/article.html")).toBe("site/img")
        expect(imageDirectoryForPage("/site/")).toBe("site/img")
        expect(replacementImagePath("/site/img/a%20b.png")).toBe(
            "site/img/a b.png"
        )
    })

    it.each([
        "/.git/config",
        "/site/.hidden/page.html",
        "/site/%2ehidden/page.html",
        "/site/.hidden.html",
    ])("rejects a page with a dot-prefixed path component: %s", value => {
        expect(() => imageDirectoryForPage(value)).toThrow()
        try {
            imageDirectoryForPage(value)
        } catch (error) {
            expect(statusCode(error)).toBe(400)
        }
    })

    it.each([
        "/site/../private/image.png",
        "/site/%2e%2e/private/image.png",
        "//server/share/image.png",
        "C:\\temp\\image.png",
        "/.git/config.png",
        "/site/.hidden/image.png",
        "/site/%2ehidden/image.png",
        "/site/img/.hidden.png",
        "/site/img/..photo.png",
        "/site/img/",
        "/site/img/file.svg",
    ])("rejects an unsafe or non-image replacement path: %s", value => {
        expect(() => replacementImagePath(value)).toThrow()
        try {
            replacementImagePath(value)
        } catch (error) {
            expect(statusCode(error)).toBeGreaterThanOrEqual(400)
        }
    })

    it("makes empty and option-like uploaded filenames safe", () => {
        expect(imageBasename(".jpg")).toBe("image")
        expect(imageBasename("-delete.jpg")).toBe("image_-delete")
        expect(imageBasename("../../My Photo.JPG")).toBe("my_photo")
    })
})
