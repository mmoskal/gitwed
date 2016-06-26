import cheerio = require("cheerio")
import Promise = require("bluebird")
import fs = require("fs")

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
    let h = cheerio.load(html, {
        lowerCaseTags: true,
        lowerCaseAttributeNames: true,
        recognizeSelfClosing: true,
        normalizeWhitespace: false,
        withStartIndices: true
    } as any)

    let idToPos: SMap<Pos> = {}

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

    function includeAsync(ctx: Ctx, e: Cheerio, filename: string) {
        return getFileAsync(filename)
            .then(fileContent => {
                let subst: SMap<Cheerio> = {}
                for (let ch of e.children().toArray()) {
                    let ch2 = h(ch)
                    let id = ch2.attr("id")
                    if (id) {
                        subst[id] = ch2;
                        (ch2 as any).gw_ctx = ctx; // save outer ctx for further expansion and filename tracking
                    }
                }
                let n = h(fileContent)
                e.replaceWith(n)
                return recAsync({ subst, filename }, n)
            })
    }

    function recAsync(ctx: Ctx, elt: Cheerio): Promise<void> {
        let eltId = elt.attr("id")
        if (eltId && ctx.subst.hasOwnProperty(eltId)) {
            let n = ctx.subst[eltId] // .clone()
            elt.replaceWith(n)
            return recAsync((ctx.subst[eltId] as any).gw_ctx, n)
        }

        if (eltId) {
            if (idToPos.hasOwnProperty(eltId)) {
                idToPos[eltId] = null
            } else {
                idToPos[eltId] = {
                    filename: ctx.filename,
                    startIdx: (elt[0] as any).startIndex
                }
            }
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