namespace gw {
    export interface CleanPasteResult {
        html: string
        isBlock: boolean
    }

    /** Return the deepest final child that ContentTools can focus. */
    export function lastFocusablePasteElement(element: any): any {
        while (element && typeof element.focus != "function") {
            if (!element.children || !element.children.length) return null
            element = element.children[element.children.length - 1]
        }
        return element
    }

    const pasteBlockTags: SMap<string> = {
        p: "p",
        h1: "h1",
        h2: "h2",
        h3: "h3",
        h4: "h4",
        h5: "h5",
        h6: "h6",
        blockquote: "blockquote",
    }

    const pasteInlineTags: SMap<string> = {
        strong: "b",
        em: "i",
        b: "b",
        i: "i",
    }

    /**
     * Convert a browser-parsed clipboard tree into the subset of HTML accepted
     * by ContentTools. Direct inline children are wrapped in paragraphs so they
     * cannot be loaded later as uneditable Static region children.
     */
    export function cleanPastedContent(root: any): CleanPasteResult {
        let cleaned = ""
        let isBlock = false
        let blockDepth = 0
        let implicitParagraph = false

        function quoteHtml(value: string) {
            return (value || "")
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
        }

        function closeImplicitParagraph() {
            if (!implicitParagraph) return
            cleaned += "</p>"
            implicitParagraph = false
        }

        function addInline(value: string) {
            if (!value) return
            if (blockDepth == 0 && !implicitParagraph) {
                cleaned += "<p>"
                implicitParagraph = true
            }
            cleaned += value
        }

        function addBlock(value: string) {
            if (blockDepth == 0) closeImplicitParagraph()
            cleaned += value
            isBlock = true
        }

        function isImageSeparator(node: any) {
            return (
                node.nodeType == 1 &&
                (node.tagName || "").toLowerCase() == "div" &&
                /^\s*<div [^>]*>\s*<img [^>]*>\s*<\/div>\s*$/.test(
                    node.innerHTML
                )
            )
        }

        function hasBlockDescendant(node: any): boolean {
            for (let i = 0; i < node.childNodes.length; ++i) {
                let child = node.childNodes[i]
                if (child.nodeType != 1) continue
                let childTag = (child.tagName || "").toLowerCase()
                if (
                    isImageSeparator(child) ||
                    pasteBlockTags.hasOwnProperty(childTag) ||
                    /^(ul|ol|li)$/.test(childTag) ||
                    hasBlockDescendant(child)
                )
                    return true
            }
            return false
        }

        function appendList(node: any, tag: string) {
            let items: { node: any; isListItem: boolean }[] = []
            for (let i = 0; i < node.childNodes.length; ++i) {
                let child = node.childNodes[i]
                if (child.nodeType != 1 && /^\s*$/.test(child.textContent || ""))
                    continue
                items.push({
                    node: child,
                    isListItem:
                        child.nodeType == 1 &&
                        (child.tagName || "").toLowerCase() == "li",
                })
            }
            if (!items.length) return

            if (blockDepth == 0) closeImplicitParagraph()
            cleaned += `<${tag}>`
            blockDepth++
            isBlock = true
            for (let item of items) {
                cleaned += "<li>"
                blockDepth++
                if (item.isListItem) {
                    for (let i = 0; i < item.node.childNodes.length; ++i)
                        append(item.node.childNodes[i])
                } else {
                    append(item.node)
                }
                blockDepth--
                cleaned += "</li>"
            }
            blockDepth--
            cleaned += `</${tag}>`
        }

        function append(node: any) {
            if (node.nodeType != 1) {
                addInline(quoteHtml(node.textContent))
                return
            }

            let tag = (node.tagName || "").toLowerCase()
            let isBlockTag = false
            let containsBlock = hasBlockDescendant(node)

            if (tag == "meta") return

            if (tag == "br") {
                addInline("<br/>\n")
                return
            }

            if (tag == "ul" || tag == "ol") {
                appendList(node, tag)
                return
            } else if (tag == "li") {
                tag = ""
            } else if (pasteBlockTags.hasOwnProperty(tag)) {
                tag = pasteBlockTags[tag]
                if (tag == "p") {
                    let style = node.getAttribute("style")
                    if (/font-weight:\s*(bold|900|800|700)/.test(style))
                        tag = "h3"
                }
                if (blockDepth == 0) closeImplicitParagraph()
                cleaned += `<${tag}>`
                blockDepth++
                isBlockTag = true
                isBlock = true
            } else if (tag == "a" && !containsBlock) {
                addInline(`<a href="${quoteHtml(node.getAttribute("href"))}">`)
            } else if (pasteInlineTags.hasOwnProperty(tag) && !containsBlock) {
                tag = pasteInlineTags[tag]
                addInline(`<${tag}>`)
            } else if (isImageSeparator(node)) {
                addBlock('<p class="text-center">* * *</p>\n')
                return
            } else {
                tag = ""
            }

            if (!tag && !containsBlock) {
                // Preserve the small set of inline styles supported by GitWEd.
                let style = node.getAttribute("style")
                if (style) {
                    if (/font-style:\s*(oblique|italic)/.test(style)) tag = "i"
                    if (/font-weight:\s*(bold|900|800|700)/.test(style))
                        tag = "b"
                    if (/vertical-align:\s*super/.test(style)) tag = "sup"
                    if (tag) addInline(`<${tag}>`)
                }
            }

            for (let i = 0; i < node.childNodes.length; ++i)
                append(node.childNodes[i])

            if (tag) cleaned += `</${tag}>`
            if (isBlockTag) blockDepth--
        }

        append(root)
        closeImplicitParagraph()

        cleaned = cleaned.replace(/-\n/g, "")
        cleaned = cleaned.replace(/\n/g, " ")
        cleaned = cleaned.replace(/\u00A0/g, " ")
        cleaned = cleaned.replace(/<\/b>(\s*)<b>/g, (f, x) => x)
        cleaned = cleaned.replace(/<b>(\s*)<\/b>/g, (f, x) => x)
        cleaned = cleaned.replace(/<\/i>(\s*)<i>/g, (f, x) => x)
        cleaned = cleaned.replace(/<p>\s*<\/p>/g, "")
        cleaned = cleaned.replace(
            /<p><b>([^<>]+)<\/b><\/p>/g,
            (f, x) => "<h3>" + x + "</h3>"
        )

        return { html: cleaned, isBlock }
    }
}
