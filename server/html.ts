import type * as CheerioModule from "cheerio"

const cheerio = require("cheerio/slim") as typeof CheerioModule

const parserOptions: any = {
    lowerCaseTags: true,
    lowerCaseAttributeNames: true,
    recognizeSelfClosing: true,
    normalizeWhitespace: false,
}

const allowedTags = new Set(
    (
        "a abbr address article aside audio b bdi bdo blockquote br caption " +
        "center cite code col colgroup data dd del details dfn div dl dt em figcaption " +
        "figure footer h1 h2 h3 h4 h5 h6 header hgroup hr i img ins kbd li main " +
        "iframe link mark meta nav ol p picture pre q rp rt ruby s samp section " +
        "small source span strong sub summary sup table tbody td tfoot th thead " +
        "time tr track u ul var video wbr"
    ).split(" ")
)

// These elements can execute code, load nested documents, submit data, or hide
// executable payloads. Their contents are discarded rather than unwrapped.
const dropWithContents = new Set(
    "applet base button canvas embed form input math object option script select style svg template textarea".split(
        " "
    )
)

const globalAttributes = new Set(
    (
        "abbr accesskey align alt axis border cellpadding cellspacing char " +
        "charoff class colspan content coords datetime dir headers height hidden " +
        "high hreflang id itemid itemprop itemref itemscope itemtype lang low max " +
        "media min open optimum rel reversed role rowspan scope shape slot span " +
        "start summary tabindex target title translate type value width"
    ).split(" ")
)

const attributesByTag: { [tag: string]: Set<string> } = {
    a: new Set("download href name referrerpolicy".split(" ")),
    audio: new Set(
        "autoplay controls crossorigin loop muted preload src".split(" ")
    ),
    blockquote: new Set(["cite"]),
    del: new Set(["cite"]),
    img: new Set(
        "crossorigin decoding ismap loading referrerpolicy sizes src srcset usemap".split(
            " "
        )
    ),
    link: new Set(["href"]),
    ins: new Set(["cite"]),
    q: new Set(["cite"]),
    source: new Set("media sizes src srcset".split(" ")),
    track: new Set("default kind label src srclang".split(" ")),
    video: new Set(
        "autoplay controls crossorigin loop muted playsinline poster preload src".split(
            " "
        )
    ),
}

const safeReferrerPolicies = new Set([
    "no-referrer",
    "same-origin",
    "strict-origin",
    "strict-origin-when-cross-origin",
])

/** Policies that disclose no more than the browser/site default. */
export function isSafeReferrerPolicy(value: string) {
    return safeReferrerPolicies.has((value || "").trim().toLowerCase())
}

const urlAttributes = new Set([
    "action",
    "archive",
    "background",
    "cite",
    "codebase",
    "data",
    "data-background",
    "formaction",
    "href",
    "longdesc",
    "manifest",
    "ping",
    "poster",
    "src",
    "xlink:href",
])
const restorableUrlAttributes = new Set([
    "data-background",
    "href",
    "poster",
    "src",
    "srcset",
])

function isAllowedAttribute(tag: string, name: string) {
    if (globalAttributes.has(name)) return true
    if (/^(aria|data)-[a-z0-9_.:-]+$/i.test(name)) return true
    return !!attributesByTag[tag] && attributesByTag[tag].has(name)
}

function normalizedForSchemeCheck(value: string) {
    let normalized = (value || "").normalize("NFKC")
    // Browsers ignore ASCII controls and whitespace in several URL parsing
    // positions. Decode percent escapes as a defensive check too, including
    // double-encoded variants used to evade naive scheme filters.
    for (let i = 0; i < 2; ++i) {
        try {
            normalized = decodeURIComponent(normalized)
        } catch {
            break
        }
    }
    return normalized.replace(
        /[\u0000-\u0020\u007f-\u009f\u00a0\u1680\u2000-\u200f\u2028-\u202f\u205f\u2060\u3000\ufeff]/g,
        ""
    )
}

export function isSafeHtmlUrl(value: string, tag = "", attr = "") {
    const normalized = normalizedForSchemeCheck(value)
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(normalized)
    if (!scheme) return true // relative, root-relative, query and fragment URLs

    const protocol = scheme[1].toLowerCase()
    if (/^(https?|mailto|tel|ftp)$/.test(protocol)) return true

    // Raster data images are useful in edited documents and cannot contain an
    // active SVG/XML document. Other data: URLs are deliberately rejected.
    return (
        protocol == "data" &&
        tag == "img" &&
        attr == "src" &&
        /^data:image\/(?:avif|gif|jpe?g|png|webp);base64,/i.test(normalized)
    )
}

function isSafeSrcset(value: string, tag: string) {
    return value.split(",").every(candidate => {
        const url = candidate.trim().split(/\s+/, 1)[0]
        return !!url && isSafeHtmlUrl(url, tag, "srcset")
    })
}

const iframeAttributes = new Set([
    "allowfullscreen",
    "class",
    "frameborder",
    "height",
    "loading",
    "referrerpolicy",
    "src",
    "title",
    "width",
])

function isSafeIframeEmbedUrl(value: string) {
    let url: URL
    try {
        url = new URL(value)
    } catch {
        return false
    }
    if (
        url.protocol != "https:" ||
        url.username ||
        url.password ||
        url.port
    )
        return false

    const host = url.hostname.toLowerCase()
    if (host == "www.youtube.com" || host == "www.youtube-nocookie.com")
        return /^\/embed\/[a-z0-9_-]+$/i.test(url.pathname)
    if (host == "player.vimeo.com")
        return /^\/video\/[0-9]+$/.test(url.pathname)
    return false
}

function isSafeIframeAttribute(name: string, value: string) {
    if (!iframeAttributes.has(name)) return false
    if (name == "src") return isSafeIframeEmbedUrl(value)
    if (name == "frameborder") return value == "0"
    if (name == "width" || name == "height")
        return /^[1-9][0-9]{0,4}$/.test(value)
    if (name == "loading") return /^(eager|lazy)$/i.test(value)
    if (name == "referrerpolicy") return isSafeReferrerPolicy(value)
    return true
}

const activeLinkRels = new Set([
    "apple-touch-icon",
    "dns-prefetch",
    "icon",
    "manifest",
    "modulepreload",
    "preconnect",
    "prefetch",
    "preload",
    "stylesheet",
])

function hasActiveLinkRel(value: string) {
    return (value || "")
        .toLowerCase()
        .split(/\s+/)
        .some(rel => activeLinkRels.has(rel))
}

function isActiveTemplateElement(
    tag: string,
    attrs: { [name: string]: string }
) {
    if (/^(applet|base|embed|iframe|object|script|style)$/.test(tag))
        return true
    if (tag == "link") return hasActiveLinkRel(attrs.rel)
    if (tag == "meta")
        return !!(attrs["http-equiv"] || "").trim()
    return false
}

/** Sanitize HTML originating in an editor or another rich-text data field. */
export function sanitizeHtmlFragment(fragment: string) {
    const h = cheerio.load((fragment || "").replace(/\r/g, ""), parserOptions)

    h("*").each((_, node: any) => {
        const e = h(node)
        const tag = (node.tagName || "").toLowerCase()
        if (!allowedTags.has(tag)) {
            if (dropWithContents.has(tag)) e.remove()
            else e.replaceWith(e.contents())
            return
        }

        const attrs: { [name: string]: string } = node.attribs || {}
        const activeMicrodataVariant =
            (tag == "meta" && !!attrs["http-equiv"]) ||
            (tag == "link" && hasActiveLinkRel(attrs.rel))

        // CDN rewriting leaves the original URL here for the editor. Restore
        // only the small set of URL attributes that can legitimately be
        // rewritten; never turn data-gw-orig-onclick/style/srcdoc into code.
        for (const name of Object.keys(attrs)) {
            const match = /^data-gw-orig-(.+)$/i.exec(name)
            if (!match) continue
            const originalValue = attrs[name]
            delete attrs[name]
            const originalName = match[1].toLowerCase()
            if (restorableUrlAttributes.has(originalName) && originalValue)
                attrs[originalName] = originalValue
        }

        for (const name of Object.keys(attrs)) {
            const lower = name.toLowerCase()
            const value = attrs[name]
            if (
                /^on/i.test(lower) ||
                lower == "style" ||
                lower == "srcdoc" ||
                (tag == "iframe"
                    ? !isSafeIframeAttribute(lower, value)
                    : !isAllowedAttribute(tag, lower))
            ) {
                delete attrs[name]
                continue
            }
            if (
                (urlAttributes.has(lower) &&
                    !isSafeHtmlUrl(value, tag, lower)) ||
                (lower == "srcset" && !isSafeSrcset(value, tag)) ||
                (lower == "referrerpolicy" &&
                    !isSafeReferrerPolicy(value))
            ) {
                delete attrs[name]
            }
        }

        if (tag == "iframe") {
            if (!attrs.src) e.remove()
            else e.empty()
            return
        }

        if (tag == "meta" || tag == "link") {
            const allowed =
                tag == "meta"
                    ? new Set(["content", "itemprop"])
                    : new Set(["href", "itemprop"])
            for (const name of Object.keys(attrs))
                if (!allowed.has(name.toLowerCase())) delete attrs[name]

            const hasValue =
                tag == "meta"
                    ? Object.prototype.hasOwnProperty.call(attrs, "content")
                    : !!attrs.href
            if (activeMicrodataVariant || !attrs.itemprop || !hasValue)
                e.remove()
            return
        }

        if (tag == "a" && /(^|\s)_blank(\s|$)/i.test(attrs.target || "")) {
            const rel = new Set((attrs.rel || "").split(/\s+/).filter(Boolean))
            rel.add("noopener")
            rel.add("noreferrer")
            attrs.rel = Array.from(rel).join(" ")
        }
    })

    h.root()
        .find("*")
        .addBack()
        .contents()
        .filter((_, node: any) => node.type == "comment")
        .remove()

    return (h.root().html() || "")
        .replace(/(^\n*)|(\n*$)/g, "\n")
}

const protectedAt = "\ue000"
const protectedPair = "\ue001"

/** Prevent data inserted in an early expansion pass from becoming a template. */
export function protectTemplatePlaceholders(value: string) {
    return (value || "")
        .replace(new RegExp(protectedAt, "g"), protectedAt + protectedAt)
        .replace(/@@/g, protectedAt + protectedPair)
}

export function restoreTemplatePlaceholders(value: string) {
    const at = "(?:" + protectedAt + "|&#x0*e000;|&#0*57344;)"
    const pair = "(?:" + protectedPair + "|&#x0*e001;|&#0*57345;)"
    return value.replace(new RegExp(at + "(" + at + "|" + pair + ")", "gi"), (
        _match,
        suffix: string
    ) => (/e001|57345/i.test(suffix) || suffix == protectedPair ? "@@" : protectedAt))
}

export interface HtmlTemplateOptions {
    /** Values already sanitized and intentionally inserted as element markup. */
    trustedHtml?: { [name: string]: string }
    /** Trusted source text, principally safely serialized inline JavaScript. */
    trustedRawText?: { [name: string]: string }
    /** Protect @@ in values from expansion by a later template pass. */
    protectValues?: boolean
    /** Leave placeholders missing from values for a later expansion pass. */
    preserveUnknown?: boolean
}

function escapeHtmlText(value: string) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
}

function htmlFragmentText(value: string) {
    return cheerio.load(value || "", parserOptions, false).root().text()
}

// dom-serializer emits direct text children of these elements without entity
// encoding. Substitution could therefore inject the element's closing tag.
const nonSubstitutableRawTextTags = new Set([
    "iframe",
    "noembed",
    "noframes",
    "noscript",
    "plaintext",
    "xmp",
])

const rcdataTags = new Set(["textarea", "title"])

/**
 * Expand placeholders according to their parsed HTML context. Values become
 * text in text nodes, quoted attribute data in ordinary attributes, and must
 * pass the URL policy in navigation/resource attributes. No substitution is
 * allowed into event handlers, CSS, srcdoc, or object data.
 */
export function expandHtmlTemplate(
    template: string,
    values: { [name: string]: any },
    options: HtmlTemplateOptions = {}
) {
    const h = cheerio.load(template || "", parserOptions)
    const textNodes: any[] = []
    const elements: any[] = []

    const collect = (node: any) => {
        if (node.type == "text") textNodes.push(node)
        if (node.type == "tag" || node.type == "script" || node.type == "style")
            elements.push(node)
        for (const child of node.childNodes || []) collect(child)
    }
    for (const node of h.root().toArray()) collect(node)

    const hasValue = (name: string) =>
        Object.prototype.hasOwnProperty.call(values, name)
    const insertedValue = (name: string, placeholder: string) => {
        if (!hasValue(name))
            return options.preserveUnknown ? placeholder : ""
        const value = values[name]
        const text = value == null ? "" : value + ""
        return options.protectValues
            ? protectTemplatePlaceholders(text)
            : text
    }

    for (const node of elements) {
        const attrs: { [name: string]: string } = node.attribs || {}
        const tag = (node.tagName || node.name || "").toLowerCase()
        const templatedAttributes = new Set<string>()
        let deferReferrerPolicyValidation = false

        // Resolve every templated attribute before deciding whether this is an
        // active resource. Otherwise href-before-rel and content-before-
        // http-equiv can observe a different element state than the reverse
        // attribute order.
        for (const name of Object.keys(attrs)) {
            if (!/@@[\w.]+@@/.test(attrs[name])) continue
            const lower = name.toLowerCase()
            templatedAttributes.add(name)
            if (
                /^on/i.test(lower) ||
                lower == "style" ||
                lower == "srcdoc"
            ) {
                delete attrs[name]
                continue
            }
            let hasPreservedUnknown = false
            const value = attrs[name].replace(
                /@@([\w.]+)@@/g,
                (match: string, key: string) => {
                    if (!hasValue(key)) {
                        if (options.preserveUnknown) {
                            hasPreservedUnknown = true
                            return match
                        }
                        return ""
                    }

                    const source = values[key]
                    const text = htmlFragmentText(
                        source == null ? "" : source + ""
                    )
                    return options.protectValues
                        ? protectTemplatePlaceholders(text)
                        : text
                }
            )
            if (lower == "referrerpolicy" && hasPreservedUnknown)
                deferReferrerPolicyValidation = true
            if (
                (urlAttributes.has(lower) &&
                    !isSafeHtmlUrl(value, tag, lower)) ||
                (lower == "srcset" && !isSafeSrcset(value, tag)) ||
                (lower == "referrerpolicy" &&
                    !hasPreservedUnknown &&
                    !isSafeReferrerPolicy(value))
            )
                delete attrs[name]
            else attrs[name] = value
        }

        if (
            attrs.referrerpolicy &&
            !deferReferrerPolicyValidation &&
            !isSafeReferrerPolicy(attrs.referrerpolicy)
        )
            delete attrs.referrerpolicy

        if (isActiveTemplateElement(tag, attrs))
            for (const name of Array.from(templatedAttributes))
                delete attrs[name]
    }

    for (const node of textNodes) {
        const source = node.data || ""
        if (!/@@[\w.]+@@/.test(source)) continue
        const parentTag = (
            (node.parent && (node.parent.tagName || node.parent.name)) ||
            ""
        ).toLowerCase()
        let isInNonSubstitutableRawText = false
        for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
            const ancestorTag = (
                ancestor.tagName ||
                ancestor.name ||
                ""
            ).toLowerCase()
            if (nonSubstitutableRawTextTags.has(ancestorTag)) {
                isInNonSubstitutableRawText = true
                break
            }
        }

        if (isInNonSubstitutableRawText) {
            node.data = source.replace(/@@[\w.]+@@/g, "")
            continue
        }

        if (parentTag == "script" || parentTag == "style") {
            node.data = source.replace(
                /@@([\w.]+)@@/g,
                (match: string, key: string) => {
                const trusted = options.trustedRawText || {}
                return Object.prototype.hasOwnProperty.call(trusted, key)
                    ? trusted[key]
                    : options.preserveUnknown && !hasValue(key)
                      ? match
                      : ""
                }
            )
            continue
        }

        const trusted = options.trustedHtml || {}
        let hasTrustedHtml = false
        source.replace(/@@([\w.]+)@@/g, (_match: string, key: string) => {
            if (Object.prototype.hasOwnProperty.call(trusted, key))
                hasTrustedHtml = true
            return ""
        })

        if (!hasTrustedHtml || rcdataTags.has(parentTag)) {
            node.data = source.replace(
                /@@([\w.]+)@@/g,
                (match: string, key: string) => insertedValue(key, match)
            )
            continue
        }

        let at = 0
        let replacement = ""
        source.replace(
            /@@([\w.]+)@@/g,
            (match: string, key: string, offset: number) => {
            replacement += escapeHtmlText(source.slice(at, offset))
            replacement += Object.prototype.hasOwnProperty.call(trusted, key)
                ? trusted[key]
                : escapeHtmlText(insertedValue(key, match))
            at = offset + match.length
            return match
            }
        )
        replacement += escapeHtmlText(source.slice(at))
        h(node).replaceWith(replacement)
    }

    return h.root().html() || ""
}
