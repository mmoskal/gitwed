import * as fs from "fs"
import * as path from "path"
import * as ts from "typescript"
import * as vm from "vm"

type TestNode = {
    nodeType: number
    textContent: string
    tagName?: string
    childNodes?: TestNode[]
    innerHTML?: string
    getAttribute?: (name: string) => string
}

function text(value: string): TestNode {
    return { nodeType: 3, textContent: value }
}

function element(
    tagName: string,
    childNodes: TestNode[],
    attributes: { [name: string]: string } = {}
): TestNode {
    return {
        nodeType: 1,
        tagName,
        childNodes,
        textContent: "",
        innerHTML: "",
        getAttribute: name => attributes[name] || null,
    }
}

function loadPasteHelpers() {
    const filename = path.join(__dirname, "../client/paste.ts")
    const source = fs.readFileSync(filename, "utf8")
    const output = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.None,
            target: ts.ScriptTarget.ES2015,
        },
        fileName: filename,
    }).outputText
    const context: any = {}
    vm.runInNewContext(output, context, { filename })
    return context.gw as {
        cleanPastedContent: (
            root: TestNode
        ) => { html: string; isBlock: boolean }
        lastFocusablePasteElement: (element: any) => any
    }
}

describe("client rich-text paste normalization", () => {
    const { cleanPastedContent, lastFocusablePasteElement } = loadPasteHelpers()

    it("preserves bold list items as an editable list", () => {
        const root = element("div", [
            element("p", [
                element("b", [text("Parking near the venue (Union South)")]),
            ]),
            element("ul", [
                element("li", [
                    element("b", [text("Union South garage")]),
                ]),
                element("li", [element("b", [text("Free parking")])]),
            ]),
        ])

        expect(cleanPastedContent(root)).toEqual({
            html:
                "<h3>Parking near the venue (Union South)</h3>" +
                "<ul><li><b>Union South garage</b></li>" +
                "<li><b>Free parking</b></li></ul>",
            isBlock: true,
        })
    })

    it("wraps inline content that follows a block", () => {
        const root = element("div", [
            element("p", [text("Introduction")]),
            element("b", [text("Union South garage")]),
        ])

        const result = cleanPastedContent(root)

        expect(result.isBlock).toBe(true)
        expect(result.html).toBe(
            "<p>Introduction</p><h3>Union South garage</h3>"
        )
    })

    it("escapes literal markup in pasted text", () => {
        const root = element("div", [
            element("p", [text("Introduction")]),
            text("</p><b>orphan</b>"),
        ])

        expect(cleanPastedContent(root).html).toBe(
            "<p>Introduction</p>" +
                "<p>&lt;/p&gt;&lt;b&gt;orphan&lt;/b&gt;</p>"
        )
    })

    it("normalizes malformed list children and removes empty nested lists", () => {
        const root = element("div", [
            element("li", [text("Bare item")]),
            element("ul", [
                text("Loose item"),
                element("li", [
                    text("Real item"),
                    element("ul", []),
                ]),
            ]),
        ])

        expect(cleanPastedContent(root).html).toBe(
            "<p>Bare item</p>" +
                "<ul><li>Loose item</li><li>Real item</li></ul>"
        )
    })

    it("emits image separators as blocks rather than nested paragraphs", () => {
        const separator = element("div", [])
        separator.innerHTML = '<div class="marker"><img src="x"></div>'
        const root = element("div", [
            separator,
            element("p", [text("After")]),
        ])

        expect(cleanPastedContent(root).html).toBe(
            '<p class="text-center">* * *</p> <p>After</p>'
        )
    })

    it("does not allow inline formatting to span an image separator", () => {
        const separator = element("div", [])
        separator.innerHTML = '<div class="marker"><img src="x"></div>'
        const root = element("div", [
            element("b", [text("Before"), separator, text("After")]),
        ])

        expect(cleanPastedContent(root).html).toBe(
            "<p>Before</p>" +
                '<p class="text-center">* * *</p> ' +
                "<p>After</p>"
        )
    })

    it("focuses the final editable text item in a pasted list", () => {
        const firstText = { focus: () => {} }
        const lastText = { focus: () => {} }
        const list = {
            children: [
                { children: [firstText] },
                { children: [lastText] },
            ],
        }

        expect(lastFocusablePasteElement(list)).toBe(lastText)
    })
})
