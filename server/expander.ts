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
    return readAsync(fn).then(b => b.toString("utf8"))
}

function expandAsync(html: string) {
    let h = cheerio.load(html, {
        lowerCaseTags: true,
        lowerCaseAttributeNames: true,
        recognizeSelfClosing: true,
        normalizeWhitespace: false
    })

    let currentSubst: SMap<Cheerio> = {}

    function withSubstAsync(s: SMap<Cheerio>, f: () => Promise<void>) {
        let prevSubst = currentSubst
        currentSubst = s
        return Promise.resolve()
            .then(f)
            .finally(() => {
                currentSubst = prevSubst
            })
    }

    function includeAsync(e: Cheerio, v: string) {
        return getFileAsync(v)
            .then(f => {
                let subst: SMap<Cheerio> = {}
                for (let ch of e.children().toArray()) {
                    let ch2 = h(ch)
                    let id = ch2.attr("id")
                    if (id) subst[id] = ch2;
                }
                let n = h(f)
                e.replaceWith(n)
                return withSubstAsync(subst, () => recAsync(n))
            })
    }

    function recAsync(e: Cheerio): Promise<void> {
        let i = e.attr("id")
        if (i && currentSubst.hasOwnProperty(i)) {
            let n = currentSubst[i].clone()
            e.replaceWith(n)
            return withSubstAsync({}, () => recAsync(n))
        }

        if (e.is("include")) {
            return includeAsync(e, e.attr("src"))
        }
        return Promise.each(e.children().toArray(), ee => recAsync(h(ee)))
            .then(() => { })
    }

    return recAsync(h.root())
        .then(() => {
            h("group").each((i, e) => {
                h(e).replaceWith(e.childNodes)
            })
            return h.html()
        })
}


export function test() {

    let frag = `
        <div id="foobar">blah</div>
        <div id="foo">eleleblah</div>
`

    expandAsync(frag)
    .then(s => {
        console.log(s)
    })


}