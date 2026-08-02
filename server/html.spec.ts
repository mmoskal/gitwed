import * as htmlSafety from "./html"

const cheerio = require("cheerio/slim")

describe("sanitizeHtmlFragment()", () => {
    it("preserves document structure, microdata, links, and images", () => {
        const input = `<article class="event" itemscope itemtype="https://schema.org/Event" data-kind="public">
<h2 itemprop="name">Tea &amp; talk</h2>
<p><a href="/events/1?q=a&amp;b=c" target="_blank">Details</a></p>
<picture><source srcset="small.webp 1x, large.webp 2x"><img src="poster.png" alt="Poster" width="640" height="480" loading="lazy"></picture>
<table><tbody><tr><th scope="row">When</th><td colspan="2">Today</td></tr></tbody></table>
</article>`

        const output = htmlSafety.sanitizeHtmlFragment(input)
        const h = cheerio.load(output)

        expect(h("article").attr("itemscope")).toBe("")
        expect(h("article").attr("itemtype")).toBe(
            "https://schema.org/Event"
        )
        expect(h("article").attr("data-kind")).toBe("public")
        expect(h("h2").text()).toBe("Tea & talk")
        expect(h("a").attr("href")).toBe("/events/1?q=a&b=c")
        expect(h("a").attr("rel")).toContain("noopener")
        expect(h("source").attr("srcset")).toBe(
            "small.webp 1x, large.webp 2x"
        )
        expect(h("img").attr("loading")).toBe("lazy")
        expect(h("td").attr("colspan")).toBe("2")
    })

    it("drops active elements and executable attributes", () => {
        const output = htmlSafety.sanitizeHtmlFragment(`<p onclick="x" style="color:red">safe</p>
<script><img src=x onerror=x></script><style>@import 'evil'</style>
<iframe srcdoc="<script>x</script>">frame</iframe><object data="data:text/html,x">object</object>
<img src="cdn.png" data-gw-orig-src="original.png" data-gw-orig-onclick="alert(1)">`)

        expect(output).toContain("safe")
        expect(output).toContain('src="original.png"')
        expect(output).not.toMatch(
            /onclick|onerror|style=|<script|<style|<iframe|srcdoc|<object|data-gw-orig/i
        )
        expect(output).not.toContain("frame")
        expect(output).not.toContain("object")
    })

    it.each([
        "javascript:alert(1)",
        "JaVaScRiPt:alert(1)",
        "java\nscript:alert(1)",
        "java%0ascript%3Aalert(1)",
        "&#x6a;avascript&#58;alert(1)",
        "data:text/html,<script>alert(1)</script>",
    ])("rejects a normalized dangerous URL: %s", url => {
        const output = htmlSafety.sanitizeHtmlFragment(
            `<a href="${url}">link</a><img src="${url}">`
        )
        const h = cheerio.load(output)
        expect(h("a").attr("href")).toBeUndefined()
        expect(h("img").attr("src")).toBeUndefined()
    })

    it("keeps safe URL forms and raster data images", () => {
        const output = htmlSafety.sanitizeHtmlFragment(
            `<a href="#part">part</a><a href="mailto:test@example.com">mail</a>` +
                `<img src="data:image/png;base64,iVBORw0KGgo=">`
        )
        const h = cheerio.load(output)
        expect(h("a").eq(0).attr("href")).toBe("#part")
        expect(h("a").eq(1).attr("href")).toBe(
            "mailto:test@example.com"
        )
        expect(h("img").attr("src")).toMatch(/^data:image\/png;base64,/)
    })

    it("validates URLs restored from CDN editor attributes", () => {
        const output = htmlSafety.sanitizeHtmlFragment(
            `<a href="/safe" data-gw-orig-href="javascript:alert(1)">link</a>`
        )
        const link = cheerio.load(output)("a")

        expect(link.attr("href")).toBeUndefined()
        expect(link.attr("data-gw-orig-href")).toBeUndefined()
    })

    it("preserves safe legacy compatibility markup", () => {
        const output = htmlSafety.sanitizeHtmlFragment(
            `<center><a name="legacy" onclick="alert(1)">old<wbr>anchor</a></center>`
        )
        const h = cheerio.load(output)

        expect(h("center")).toHaveLength(1)
        expect(h("wbr")).toHaveLength(1)
        expect(h("a").attr("name")).toBe("legacy")
        expect(h("a").attr("onclick")).toBeUndefined()
    })

    it.each([
        "no-referrer-when-downgrade",
        "origin",
        "origin-when-cross-origin",
        "unsafe-url",
        "not-a-policy",
    ])("rejects a referrer policy that weakens the default: %s", policy => {
        const output = htmlSafety.sanitizeHtmlFragment(
            `<a href="/next" referrerpolicy="${policy}">next</a>` +
                `<img src="image.png" referrerpolicy="${policy}">`
        )
        const h = cheerio.load(output)

        expect(h("a").attr("referrerpolicy")).toBeUndefined()
        expect(h("img").attr("referrerpolicy")).toBeUndefined()
    })

    it.each([
        "no-referrer",
        "same-origin",
        "strict-origin",
        "strict-origin-when-cross-origin",
    ])("keeps a non-weakening referrer policy: %s", policy => {
        const output = htmlSafety.sanitizeHtmlFragment(
            `<a href="/next" referrerpolicy="${policy}">next</a>`
        )
        expect(cheerio.load(output)("a").attr("referrerpolicy")).toBe(
            policy
        )
    })

    it("preserves ContentTools video embeds with constrained attributes", () => {
        const output = htmlSafety.sanitizeHtmlFragment(
            `<iframe frameborder="0" height="300" src="https://www.youtube.com/embed/abc_123-X?start=20" width="400" class="align-left"></iframe>` +
                `<iframe frameborder="0" height="300" src="https://www.youtube-nocookie.com/embed/nocookie_1" width="400"></iframe>` +
                `<iframe frameborder="0" height="300" src="https://player.vimeo.com/video/123456?h=abc" width="400"></iframe>`
        )
        const h = cheerio.load(output)

        expect(h("iframe")).toHaveLength(3)
        expect(h("iframe").eq(0).attr()).toEqual({
            frameborder: "0",
            height: "300",
            src: "https://www.youtube.com/embed/abc_123-X?start=20",
            width: "400",
            class: "align-left",
        })
        expect(h("iframe").eq(1).attr("src")).toContain(
            "www.youtube-nocookie.com/embed/"
        )
        expect(h("iframe").eq(2).attr("src")).toContain(
            "player.vimeo.com/video/123456"
        )
    })

    it("drops entity-encoded fallback content from safe iframes", () => {
        const output = htmlSafety.sanitizeHtmlFragment(
            `<iframe src="https://www.youtube.com/embed/safe">&lt;/iframe&gt;&lt;img src=x onerror=alert(1)&gt;</iframe>`
        )
        const h = cheerio.load(output)

        expect(h("iframe")).toHaveLength(1)
        expect(h("iframe").attr("src")).toBe(
            "https://www.youtube.com/embed/safe"
        )
        expect(h("iframe").contents()).toHaveLength(0)
        expect(h("img")).toHaveLength(0)
        expect(output).not.toMatch(/onerror|<img/i)
    })

    it("rejects other iframe documents and strips active iframe attributes", () => {
        const output = htmlSafety.sanitizeHtmlFragment(
            `<iframe src="http://www.youtube.com/embed/abc">http</iframe>` +
                `<iframe src="https://evil.invalid/embed/abc">other</iframe>` +
                `<iframe src="https://www.youtube.com/watch?v=abc">watch</iframe>` +
                `<iframe src="https://user@www.youtube.com/embed/abc">credentials</iframe>` +
                `<iframe srcdoc="<script>alert(1)</script>">nested</iframe>` +
                `<iframe src="https://www.youtube.com/embed/safe" onload="alert(1)" srcdoc="evil" style="display:none" frameborder="1" height="calc(1px)" width="400"></iframe>`
        )
        const h = cheerio.load(output)

        expect(h("iframe")).toHaveLength(1)
        expect(h("iframe").attr()).toEqual({
            src: "https://www.youtube.com/embed/safe",
            width: "400",
        })
        expect(output).not.toMatch(/http<|other|watch|credentials|nested|onload|srcdoc|style=/i)
    })

    it("keeps microdata-only meta/link and rejects active variants", () => {
        const output = htmlSafety.sanitizeHtmlFragment(
            `<meta itemprop="description" content="A safe description">` +
                `<link itemprop="url" href="/event/1?q=a&amp;b=c">` +
                `<meta http-equiv="refresh" content="0;url=https://evil.invalid" itemprop="description">` +
                `<link rel="stylesheet" href="https://evil.invalid/x.css" itemprop="url">` +
                `<link itemprop="url" href="javascript:alert(1)">`
        )
        const h = cheerio.load(output)

        expect(h("meta")).toHaveLength(1)
        expect(h("meta").attr()).toEqual({
            itemprop: "description",
            content: "A safe description",
        })
        expect(h("link")).toHaveLength(1)
        expect(h("link").attr()).toEqual({
            itemprop: "url",
            href: "/event/1?q=a&b=c",
        })
        expect(output).not.toMatch(/http-equiv|refresh|stylesheet|evil\.invalid|javascript/i)
    })
})

describe("expandHtmlTemplate()", () => {
    it("inserts data as text without double escaping", () => {
        const output = htmlSafety.expandHtmlTemplate(
            `<p>Welcome, @@name@@</p>`,
            { name: `Tom & <b>"friends"</b>` }
        )
        const h = cheerio.load(output)

        expect(h("p").text()).toBe(`Welcome, Tom & <b>"friends"</b>`)
        expect(h("p b")).toHaveLength(0)
        expect(output).toContain("Tom &amp; &lt;b&gt;")
        expect(output).not.toContain("&amp;amp;")
    })

    it("quotes ordinary attributes and validates URL attributes", () => {
        const output = htmlSafety.expandHtmlTemplate(
            `<div title="Hello @@title@@" data-name="@@title@@"></div>` +
                `<a href="@@badUrl@@">bad</a><a href="/p?q=@@query@@">ok</a>`,
            {
                title: `x" onclick="alert(1)`,
                badUrl: " java\nscript:alert(1)",
                query: `a&next=" onclick="x`,
            }
        )
        const h = cheerio.load(output)

        expect(h("div").attr("title")).toBe(
            `Hello x" onclick="alert(1)`
        )
        expect(h("div").attr("onclick")).toBeUndefined()
        expect(h("a").eq(0).attr("href")).toBeUndefined()
        expect(h("a").eq(1).attr("href")).toBe(
            `/p?q=a&next=" onclick="x`
        )
    })

    it("renders HTML fragments as attribute text before policy checks", () => {
        const rich = `<strong>value</strong>`
        const output = htmlSafety.expandHtmlTemplate(
            `<p title="@@rich@@">@@rich@@</p>` +
                `<a href="@@url@@">safe</a>` +
                `<a href="@@badUrl@@">bad</a>` +
                `<img referrerpolicy="@@policy@@">`,
            {
                rich,
                url: `<strong>https://example.com/value</strong>`,
                badUrl: `<strong>javascript:alert(1)</strong>`,
                policy: `<em>same-origin</em>`,
            },
            { trustedHtml: { rich } }
        )
        const h = cheerio.load(output)

        expect(h("p").attr("title")).toBe("value")
        expect(h("p strong").text()).toBe("value")
        expect(h("a").eq(0).attr("href")).toBe(
            "https://example.com/value"
        )
        expect(h("a").eq(1).attr("href")).toBeUndefined()
        expect(h("img").attr("referrerpolicy")).toBe("same-origin")
    })

    it("does not substitute values into active attribute or raw-text contexts", () => {
        const output = htmlSafety.expandHtmlTemplate(
            `<img onload="@@value@@" style="@@value@@" srcdoc="@@value@@">` +
                `<object data="@@value@@"></object>` +
                `<script src="@@safeUrl@@">const x = "@@value@@"</script>` +
                `<link rel="stylesheet" href="@@safeUrl@@"><style>@@value@@</style>`,
            { value: `";alert(1)//`, safeUrl: "https://evil.invalid/code.js" }
        )
        const h = cheerio.load(output)

        expect(h("img").attr()).toEqual({})
        expect(h("object").attr("data")).toBeUndefined()
        expect(h("script").attr("src")).toBeUndefined()
        expect(h("link").attr("href")).toBeUndefined()
        expect(h("script").text()).not.toContain("alert")
        expect(h("style").text()).not.toContain("alert")
    })

    it.each([
        "iframe",
        "noembed",
        "noframes",
        "noscript",
        "plaintext",
        "xmp",
    ])("does not substitute nested placeholders in <%s> across passes", tag => {
        const firstPass = htmlSafety.expandHtmlTemplate(
            `<${tag}><b>before@@known@@/@@later@@after</b></${tag}>`,
            { known: `</${tag}><img src=x onerror=alert(1)>` },
            { preserveUnknown: true, protectValues: true }
        )
        const output = htmlSafety.expandHtmlTemplate(firstPass, {
            later: `</${tag}><img src=x onerror=alert(2)>`,
        })

        expect(output).not.toContain("@@")
        expect(output).not.toContain("<img")
        expect(output).not.toContain("onerror")
    })

    it.each(["title", "textarea"])(
        "escapes a closing-tag payload substituted into <%s>",
        tag => {
            const payload = `</${tag}><img src=x onerror=alert(1)>`
            const output = htmlSafety.expandHtmlTemplate(
                `<${tag}>@@value@@</${tag}>`,
                { value: payload }
            )
            const h = cheerio.load(output)

            expect(h("img")).toHaveLength(0)
            expect(output).toContain(`&lt;/${tag}&gt;`)
            expect(output).not.toContain("<img")
        }
    )

    it.each([
        `<link href="@@url@@" rel="@@rel@@">`,
        `<link rel="@@rel@@" href="@@url@@">`,
    ])(
        "uses final link state regardless of templated attribute order: %s",
        template => {
            const output = htmlSafety.expandHtmlTemplate(template, {
                rel: "stylesheet",
                url: "https://evil.invalid/style.css",
            })
            expect(cheerio.load(output)("link").attr()).toEqual({})
        }
    )

    it.each([
        `<meta content="@@content@@" http-equiv="@@equiv@@">`,
        `<meta http-equiv="@@equiv@@" content="@@content@@">`,
    ])(
        "uses final meta state regardless of templated attribute order: %s",
        template => {
            const output = htmlSafety.expandHtmlTemplate(template, {
                equiv: "refresh",
                content: "0;url=https://evil.invalid",
            })
            expect(cheerio.load(output)("meta").attr()).toEqual({})
        }
    )

    it("rejects weakening referrer policies during template expansion", () => {
        const output = htmlSafety.expandHtmlTemplate(
            `<a href="/weak" referrerpolicy="@@weak@@">weak</a>` +
                `<a href="/safe" referrerpolicy="@@safe@@">safe</a>` +
                `<img src="image.png" referrerpolicy="unsafe-url">`,
            { weak: "unsafe-url", safe: "same-origin" }
        )
        const h = cheerio.load(output)

        expect(h("a").eq(0).attr("referrerpolicy")).toBeUndefined()
        expect(h("a").eq(1).attr("referrerpolicy")).toBe("same-origin")
        expect(h("img").attr("referrerpolicy")).toBeUndefined()
    })

    it("allows only explicitly trusted, pre-sanitized markup and raw text", () => {
        const rich = htmlSafety.sanitizeHtmlFragment(
            `<p><b>Welcome</b><img src=x onerror=alert(1)></p>`
        )
        const output = htmlSafety.expandHtmlTemplate(
            `<main>@@body@@</main><script>@@bootstrap@@</script>`,
            { body: rich, bootstrap: "ignored" },
            {
                trustedHtml: { body: rich },
                trustedRawText: { bootstrap: `const safe = {"x":"\\u003c"};` },
            }
        )
        const h = cheerio.load(output)

        expect(h("main p b").text()).toBe("Welcome")
        expect(h("main img").attr("onerror")).toBeUndefined()
        expect(h("script").text()).toContain("const safe")
    })

    it("does not reinterpret placeholders introduced by an earlier pass", () => {
        const early = htmlSafety.expandHtmlTemplate(
            `<p>@@remote@@</p><a title="@@remote@@">x</a>`,
            { remote: "@@secret@@" },
            { protectValues: true }
        )
        const late = htmlSafety.expandHtmlTemplate(early, {
            secret: `<img src=x onerror=alert(1)>`,
        })
        const output = htmlSafety.restoreTemplatePlaceholders(late)
        const h = cheerio.load(output)

        expect(h("p").text()).toBe("@@secret@@")
        expect(h("a").attr("title")).toBe("@@secret@@")
        expect(output).not.toContain("onerror")
    })
})
