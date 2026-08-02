import { Service } from "./rest"
import * as tools from "./tools"
import * as htmlSafety from "./html"

const cheerio = require("cheerio/slim")

describe("REST HTML expansion", () => {
    afterEach(() => jest.restoreAllMocks())

    it("uses text/URL contexts and protects remote placeholder text", async () => {
        jest.spyOn(tools, "requestAsync").mockResolvedValue({
            statusCode: 200,
            json: {
                name: `<img src=x onerror=alert(1)>`,
                url: "java\nscript:alert(1)",
                marker: "@@secret@@",
                entityMarker: "&#64;&#64;pageTitle&#64;&#64;",
                remoteTitle: `<strong>Remote</strong>`,
                remoteBase: "https://cdn.example/",
            },
        } as any)

        const h = cheerio.load(
            `<rest id="42"><a href="@@url@@">@@name@@</a>` +
                `<p title="@@remoteTitle@@ / @@pageTitle@@" data-marker="@@entityMarker@@">@@marker@@ / @@pageText@@</p>` +
                `<link rel="stylesheet" href="@@remoteBase@@@@pagePath@@"></rest>`
        )
        const service = new Service({
            id: "test",
            format: "https://service.invalid/items/{ID}",
        })

        await service.expandAsync(h("rest"))
        const final = htmlSafety.restoreTemplatePlaceholders(
            htmlSafety.expandHtmlTemplate(h.root().html() || "", {
                secret: `<svg onload=alert(1)>`,
                pageTitle: "Page",
                pageText: "local",
                pagePath: "style.css",
            })
        )
        const rendered = cheerio.load(final)

        expect(rendered("a").text()).toBe(`<img src=x onerror=alert(1)>`)
        expect(rendered("a").attr("href")).toBeUndefined()
        expect(rendered("p").attr("title")).toBe("Remote / Page")
        expect(rendered("p").attr("data-marker")).toBe("@@pageTitle@@")
        expect(rendered("p").text()).toBe("@@secret@@ / local")
        expect(rendered("link").attr("href")).toBeUndefined()
        expect(final).not.toContain("<svg")
    })

    it("validates preserved referrer policies after page expansion", async () => {
        jest.spyOn(tools, "requestAsync").mockResolvedValue({
            statusCode: 200,
            json: {
                safePrefix: "same-",
                unsafePrefix: "unsafe-",
            },
        } as any)

        const h = cheerio.load(
            `<rest id="42">` +
                `<a class="safe" referrerpolicy="@@pageSafe@@">safe</a>` +
                `<a class="unsafe" referrerpolicy="@@pageUnsafe@@">unsafe</a>` +
                `<a class="mixed-safe" referrerpolicy="@@safePrefix@@@@pageSafeSuffix@@">mixed safe</a>` +
                `<a class="mixed-unsafe" referrerpolicy="@@unsafePrefix@@@@pageUnsafeSuffix@@">mixed unsafe</a>` +
                `</rest>`
        )
        const service = new Service({
            id: "test",
            format: "https://service.invalid/items/{ID}",
        })

        await service.expandAsync(h("rest"))
        expect(h("a.safe").attr("referrerpolicy")).toBe("@@pageSafe@@")
        expect(h("a.unsafe").attr("referrerpolicy")).toBe(
            "@@pageUnsafe@@"
        )

        const final = htmlSafety.restoreTemplatePlaceholders(
            htmlSafety.expandHtmlTemplate(h.root().html() || "", {
                pageSafe: "same-origin",
                pageUnsafe: "unsafe-url",
                pageSafeSuffix: "origin",
                pageUnsafeSuffix: "url",
            })
        )
        const rendered = cheerio.load(final)

        expect(rendered("a.safe").attr("referrerpolicy")).toBe(
            "same-origin"
        )
        expect(rendered("a.unsafe").attr("referrerpolicy")).toBeUndefined()
        expect(rendered("a.mixed-safe").attr("referrerpolicy")).toBe(
            "same-origin"
        )
        expect(
            rendered("a.mixed-unsafe").attr("referrerpolicy")
        ).toBeUndefined()
    })

    it("does not carry iframe fallback placeholders into the page pass", async () => {
        jest.spyOn(tools, "requestAsync").mockResolvedValue({
            statusCode: 200,
            json: {},
        } as any)

        const iframe = htmlSafety.sanitizeHtmlFragment(
            `<iframe src="https://www.youtube.com/embed/safe">@@pageFallback@@</iframe>`
        )
        const h = cheerio.load(`<rest id="42">${iframe}</rest>`)
        const service = new Service({
            id: "test",
            format: "https://service.invalid/items/{ID}",
        })

        await service.expandAsync(h("rest"))
        const final = htmlSafety.restoreTemplatePlaceholders(
            htmlSafety.expandHtmlTemplate(h.root().html() || "", {
                pageFallback: `</iframe><img onerror="alert(1)">`,
            })
        )
        const rendered = cheerio.load(final)

        expect(rendered("iframe")).toHaveLength(1)
        expect(rendered("iframe").attr("src")).toBe(
            "https://www.youtube.com/embed/safe"
        )
        expect(rendered("img")).toHaveLength(0)
        expect(final).not.toMatch(/@@pageFallback@@|onerror/i)
    })
})
