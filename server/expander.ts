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

function expandAsync(filename: string, html: string) {
    let h = cheerio.load(html, {
        lowerCaseTags: true,
        lowerCaseAttributeNames: true,
        recognizeSelfClosing: true,
        normalizeWhitespace: false
    })

    return recAsync({ filename, subst: {} }, h.root())
        .then(() => {
            h("group").each((i, e) => {
                h(e).replaceWith(e.childNodes)
            })
            return h.html()
        })

    function includeAsync(ctx: Ctx, e: Cheerio, filename: string) {
        return getFileAsync(filename)
            .then(f => {
                let subst: SMap<Cheerio> = {}
                for (let ch of e.children().toArray()) {
                    let ch2 = h(ch)
                    let id = ch2.attr("id")
                    if (id) {
                        subst[id] = ch2;
                        (ch2 as any).gw_ctx = ctx; // save ctx for further expansion and filename tracking
                    }
                }
                let n = h(f)
                e.replaceWith(n)
                let ctx2: Ctx = {
                    subst, filename
                }
                return recAsync(ctx, n)
            })
    }

    function recAsync(ctx: Ctx, e: Cheerio): Promise<void> {
        let i = e.attr("id")
        if (i && ctx.subst.hasOwnProperty(i)) {
            let n = ctx.subst[i].clone()
            e.replaceWith(n)
            return recAsync((ctx.subst[i] as any).gw_ctx, n)
        }

        if (e.is("include")) {
            return includeAsync(ctx, e, e.attr("src"))
        }
        return Promise.each(e.children().toArray(), ee => recAsync(ctx, h(ee)))
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
            console.log(s)
        })
}