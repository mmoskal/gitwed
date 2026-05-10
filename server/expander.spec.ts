import {
    cleanHtmlFragment,
    parseIncludedHtml,
    replicatePictureSource,
} from "./expander"
import { cheerioFixture } from "./fixtures"

describe("replication", () => {
    describe("replicatePictureSource()", () => {
        it("replicates source correctly", async () => {
            const cheerio = cheerioFixture(jest.fn(() => "assets/img.png"))

            const replicate = jest.fn(() => Promise.resolve("cdn/img.png"))
            await replicatePictureSource(cheerio, replicate)[0]

            //@ts-ignore
            expect(cheerio.attr.mock.calls[1]).toEqual([
                "srcset",
                "cdn/img.png",
            ])
            //@ts-ignore
            expect(cheerio.attr.mock.calls[2]).toEqual([
                "data-gw-orig-srcset",
                "assets/img.png",
            ])
        })

        it("replicates source with width and height", async () => {
            const cheerio = cheerioFixture(
                jest.fn(() => "assets/img.png w100 h100")
            )

            const replicate = jest.fn(() => Promise.resolve("cdn/img.png"))
            await replicatePictureSource(cheerio, replicate)[0]

            //@ts-ignore
            expect(cheerio.attr.mock.calls[1]).toEqual([
                "srcset",
                "cdn/img.png w100 h100",
            ])
            //@ts-ignore
            expect(cheerio.attr.mock.calls[2]).toEqual([
                "data-gw-orig-srcset",
                "assets/img.png w100 h100",
            ])
        })

        it("replicates source with width and height", async () => {
            const cheerio = cheerioFixture(
                jest.fn(
                    () => "assets/img.png w100 h100, assets/img2.png w200 h200"
                )
            )

            const replicate = jest.fn()
            replicate
                .mockReturnValueOnce(Promise.resolve("cdn/img.png"))
                .mockReturnValueOnce(Promise.resolve("cdn/img2.png"))
            await replicatePictureSource(cheerio, replicate)[0]

            //@ts-ignore
            expect(cheerio.attr.mock.calls[1]).toEqual([
                "srcset",
                "cdn/img.png w100 h100, cdn/img2.png w200 h200",
            ])
            //@ts-ignore
            expect(cheerio.attr.mock.calls[2]).toEqual([
                "data-gw-orig-srcset",
                "assets/img.png w100 h100, assets/img2.png w200 h200",
            ])
        })
    })
})

describe("cleanHtmlFragment()", () => {
    it("removes event handler attributes before saving editor HTML", () => {
        const html = cleanHtmlFragment(
            `<p onclick="alert(1)">x</p><img src="x.png" onload="alert(2)">`
        )

        expect(html).not.toMatch(/onload|onclick/i)
        expect(html).toContain(`src="x.png"`)
    })
})

describe("parseIncludedHtml()", () => {
    it("parses XML document include content as markup", () => {
        const nodes = parseIncludedHtml(
            `<?xml version="1.0" encoding="utf-8"?>
<html>
<body><div edit id="main">content</div></body>
</html>`
        )

        expect(nodes.find("[edit]").attr("id")).toBe("main")
    })

    it("keeps fragment include content as top-level markup", () => {
        const nodes = parseIncludedHtml(`<p id="fragment">content</p>`)

        expect(nodes.attr("id")).toBe("fragment")
    })
})
