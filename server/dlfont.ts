import * as tools from './tools'
import * as expander from './expander'
import * as bluebird from 'bluebird'
import * as fs from 'fs'

function getAsync(url: string) {
    return tools.requestAsync({
        url: url,
        headers: {
            // pretend to be IE11 so we get WOFF not WOFF2
            "User-Agent": "Mozilla/5.0 (Windows NT 6.3; Trident/7.0; rv:11.0) like Gecko"
        }
    })
}

function unquote(s: string) {
    let m = /^'(.*)'$/.exec(s)
    if (m) {
        s = m[1]
    } else {
        m = /^"(.*)"$/.exec(s)
        if (m) s = m[1]
    }
    s = s.replace(/\&amp;/g, "&")
    return s
}

export function rewriteCSS(url: string) {
    return getAsync(url)
        .then<string>(resp => {
            let dls: SMap<string> = {}
            let tokId = 0
            //   src: local('Foobar Light'), local('Foobar-Light'), url(https://example.com/foobar.woff) format('woff');
            let css = resp.text.replace(/src:([^};]+);?/g, (f, src: string) => {
                if (/^\s*url\([^\)]+\.eot[^\)]*\)\s*$/.test(src))
                    return "";
                let numdl = 0
                src = src.trim() + ","
                src = src.replace(/local\([^\)]+\),\s*/g, "")
                src = src.replace(/url\(([^\)]+)\)\s*format\(([^\)]+)\)\s*,/g,
                    (f, furl: string, fmt: string) => {
                        if (unquote(fmt) != "woff") return ""
                        let tok = "##FONTDL" + tokId++ + "##"
                        furl = unquote(furl)
                        if (/^http/.test(furl)) { }
                        else {
                            let mm = /^(https?:\/\/[^\/]+)(.*)/.exec(url)
                            let host = mm[1]
                            let path = mm[2]
                            if (/^\//.test(furl)) {
                                furl = host + furl
                            } else {
                                furl = host + expander.relativePath(path, furl)
                            }
                        }
                        dls[tok] = unquote(furl)
                        numdl++
                        return "url(data:application/x-font-woff;charset=utf-8;base64," + tok +
                            ") format('woff'),"
                    })
                src = src.replace(/,+\s*$/, "")
                if (numdl != 1) {
                    console.log("cannot parse " + f)
                    return f
                }
                return "src: " + src + ";"
            })
            return bluebird.map(Object.keys(dls),
                id => getAsync(dls[id])
                    .then(resp => {
                        console.log("DL " + dls[id] + " -> " + resp.buffer.length + " bytes")
                        css = css.replace(id, resp.buffer.toString("base64"))
                    }))
                .then(() => css)
        })
}

function main() {
    rewriteCSS(process.argv[2])
        .then(res => {
            fs.writeFileSync("font.css", res)
            console.log("font.css written")
        })
}

if (require.main === module) {
    main()
}
