import cheerio = require("cheerio")
import Promise = require("bluebird")
import fs = require("fs")
let htmlparser2 = require("htmlparser2")

function jsQuote(s: string) {
    return "\"" + s.replace(/[\\"\n\r\t]/g, (m) => {
        switch (m) {
            case "\\":
            case "\"": return "\\" + m;
            case "\n": return "\\n";
            case "\r": return "\\r";
            case "\t": return "\\t";
            default: return m;
        }
    }) + "\""
}

function error(msg: string) {
    throw new Error(msg)
}

type SMap<T> = { [s: string]: T };

let readAsync = Promise.promisify(fs.readFile)

function getFileAsync(fn: string) {
    return readAsync("html/" + fn).then(b => b.toString("utf8"))
}

interface Ctx {
    filename: string;
    subst: SMap<Cheerio>;
}

interface Pos {
    filename: string;
    startIdx: number;
}

function expandAsync(filename: string, html: string) {
    let options: any = {
        lowerCaseTags: true,
        lowerCaseAttributeNames: true,
        recognizeSelfClosing: true,
        normalizeWhitespace: false,
        withStartIndices: true
    }
    let h = cheerio.load(html, options)

    let idToPos: SMap<Pos> = {}

    setLocations(h.root(), filename, html)
    return recAsync({ filename, subst: {} }, h.root())
        .then(() => {
            h("group").each((i, e) => {
                h(e).replaceWith(e.childNodes)
            })
            return {
                idToPos,
                html: h.html()
            }
        })

    function setLocations(e: Cheerio, filename: string, fileContent: string) {
        let mapping: SMap<number> = {}
        let parser: any
        let handler = new htmlparser2.DomHandler(options, (elt: CheerioElement) => {
            //console.log(elt.tagName, elt.startIndex, parser.endIndex)
            mapping[elt.startIndex + ""] = parser.startIndex
        });
        parser = new htmlparser2.Parser(handler, options)
        parser.end(fileContent);

        e.find("[id]").each((i, ch) => {
            let x = h(ch)
            let start = ch.startIndex
            let end = mapping[start + ""]
            if (fileContent[start] == "<") {
                while (start < fileContent.length && fileContent[start] != ">")
                    start++;
                start++;
            }
            console.log(`${ch.tagName}: "${fileContent.slice(start, end)}"`)
            x.attr("gw-pos", filename + "@" + start + "-" + (end - start))
        })
    }

    function includeAsync(ctx: Ctx, e: Cheerio, filename: string) {
        return getFileAsync(filename)
            .then(fileContent => {
                let subst: SMap<Cheerio> = {}
                for (let ch of e.children().toArray()) {
                    let ch2 = h(ch)
                    let id = ch2.attr("id")
                    if (id) {
                        subst[id] = ch2;
                        ch2.gw_ctx = ctx; // save outer ctx for further expansion and filename tracking
                    }
                }
                let n = h(fileContent)
                setLocations(n, filename, fileContent)
                e.replaceWith(n)
                return recAsync({ subst, filename }, n)
            })
    }

    function recAsync(ctx: Ctx, elt: Cheerio): Promise<void> {
        let eltId = elt.attr("id")
        if (eltId && ctx.subst.hasOwnProperty(eltId)) {
            let n = ctx.subst[eltId].clone()
            elt.replaceWith(n)
            return recAsync(ctx.subst[eltId].gw_ctx, n)
        }

        if (elt.is("include")) {
            return includeAsync(ctx, elt, elt.attr("src"))
        }
        return Promise.each(elt.children().toArray(), ee => recAsync(ctx, h(ee)))
            .then(() => { })
    }
}

function expandFileAsync(n: string) {
    return getFileAsync(n)
        .then(s => expandAsync(n, s))

}

export function test() {
    return expandFileAsync("welcome.html")
        .then(s => {
            console.log(s.html)
            console.log(s.idToPos)
        })
}