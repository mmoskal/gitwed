import * as zlib from 'zlib';
import * as url from 'url';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import * as events from 'events';
import * as querystring from 'querystring';
import * as bluebird from 'bluebird';
import * as crypto from "crypto";
import express = require('express');
import mime = require('mime');

const maxCacheSize = 32 * 1024 * 1024
const maxCacheEltSize = 256 * 1024

export interface Locale {
    lang: string; // "polski"
    countries: string[]; // ["pl"]
    shortdate: string; // "@day@ @monthname@",
    clock: number; // 12 or 24
    translations: SMap<string>;
    titlePlaceholder: string;
    programPlaceholder: string;
}

let localeEn: Locale = {
    lang: "English",
    countries: ["us", "gb", "au", "nz"],
    shortdate: "@monthname@ @day@",
    clock: 12,
    titlePlaceholder: "Introduction to Buddhism by D. W. Teacher",
    programPlaceholder: "<p>Details coming up soon!</p>",
    translations: {}
}

export function validateLang(l: string) {
    if (typeof l != "string") return false
    return /^[a-z][a-z](-[A-Z]{2,3})?$/.test(l)
}

export function mimeLookup(fn: string) {
    if (mime.getType)
        return mime.getType(fn)
    return (mime as any).lookup(fn)
}

const localeCache: SMap<Locale> = {}
export function getLocale(lang: string) {
    let r = lookup(localeCache, lang)
    if (r) return r

    if (validateLang(lang)) {
        if (/^en/.test(lang)) {
            return (localeCache[lang] = localeEn)
        }

        let fn = "locales/" + lang + ".json"
        if (!fs.existsSync(fn)) {
            fn = "locales/" + lang.replace(/-.*/, "") + ".json"
        }
        if (fs.existsSync(fn)) {
            r = JSON.parse(fs.readFileSync(fn, "utf8"))
        }
    }
    if (!r) r = {} as any
    if (!r.lang) r.lang = lang
    if (!r.countries) r.countries = [lang]
    if (!r.clock) r.clock = 24
    if (!r.shortdate) r.shortdate = "@monthnumber@-@day0@"
    if (!r.translations) r.translations = {}
    if (!r.titlePlaceholder) r.titlePlaceholder = localeEn.titlePlaceholder
    if (!r.programPlaceholder) r.programPlaceholder = localeEn.programPlaceholder
    localeCache[lang] = r
    return r
}

export function readResAsync(g: events.EventEmitter) {
    return new Promise<Buffer>((resolve, reject) => {
        let bufs: Buffer[] = []
        g.on('data', (c: any) => {
            if (typeof c === "string")
                bufs.push(new Buffer(c, "utf8"))
            else
                bufs.push(c)
        });

        g.on("error", (err: any) => reject(err))

        g.on('end', () => resolve(Buffer.concat(bufs)))
    })
}

export interface HttpRequestOptions {
    url: string;
    method?: string; // default to GET
    data?: any;
    headers?: SMap<string>;
    query?: SMap<string>;
    allowHttpErrors?: boolean; // don't treat non-200 responses as errors
}

export interface HttpResponse {
    statusCode: number;
    headers: SMap<string>;
    buffer?: Buffer;
    text?: string;
    json?: any;
}

export async function requestAsync(options: HttpRequestOptions): Promise<HttpResponse> {
    if (options.query) {
        let q = querystring.stringify(options.query)
        if (options.url.indexOf("?") >= 0)
            options.url += "&" + q
        else
            options.url += "?" + q
    }
    let resp = await httpRequestCoreAsync(options)
    if (resp.statusCode != 200 && !options.allowHttpErrors) {
        let msg = `Bad HTTP status code: ${resp.statusCode} at ${options.url}; message: ${(resp.text || "").slice(0, 500)}`
        let err: any = new Error(msg)
        err.statusCode = resp.statusCode
        throw err
    }
    if (resp.text && /application\/json/.test(resp.headers["content-type"]))
        resp.json = JSON.parse(resp.text)
    return resp
}

function httpRequestCoreAsync(options: HttpRequestOptions): Promise<HttpResponse> {
    let isHttps = false

    let u = <http.RequestOptions><any>url.parse(options.url)

    if (u.protocol == "https:") isHttps = true
    else if (u.protocol == "http:") isHttps = false
    else return Promise.reject("bad protocol: " + u.protocol)

    u.headers = options.headers ? JSON.parse(JSON.stringify(options.headers)) : {}
    let data = options.data
    u.method = options.method || (data == null ? "GET" : "POST");

    let mod: any = isHttps ? https : http;

    let buf: Buffer = null;

    u.headers["accept-encoding"] = "gzip"

    if (data != null) {
        if (Buffer.isBuffer(data)) {
            buf = data;
        } else if (typeof data == "object") {
            buf = new Buffer(JSON.stringify(data), "utf8")
            u.headers["content-type"] = "application/json; charset=utf8"
        } else if (typeof data == "string") {
            buf = new Buffer(data, "utf8")
        } else {
            throw new Error("bad data");
        }
    }

    if (buf)
        u.headers['content-length'] = buf.length

    return new Promise<HttpResponse>((resolve, reject) => {
        let req = mod.request(u, (res: any) => {
            let g: events.EventEmitter = res;
            if (/gzip/.test(res.headers['content-encoding'])) {
                let tmp = zlib.createUnzip();
                res.pipe(tmp);
                g = tmp;
            }

            resolve(readResAsync(g).then(buf => {
                let text: string = null
                try {
                    text = buf.toString("utf8")
                } catch (e) {
                }
                let resp: HttpResponse = {
                    statusCode: res.statusCode,
                    headers: res.headers,
                    buffer: buf,
                    text: text
                }
                return resp;
            }))
        })
        req.on('error', (err: any) => reject(err))
        req.end(buf)
    })
}

export function mkdirP(thePath: string) {
    if (thePath == ".") return;
    if (!fs.existsSync(thePath)) {
        mkdirP(path.dirname(thePath))
        fs.mkdirSync(thePath)
    }
}

interface QEntry {
    run: () => Promise<any>;
    resolve: (v: any) => void;
    reject: (err: any) => void;
}

export function promiseQueue() {
    let awaiting: SMap<QEntry[]> = {}

    function poke(id: string) {
        let lst = awaiting[id]
        if (!lst) return
        let ent = lst[0]
        let shift = () => {
            lst.shift()
            if (lst.length == 0) delete awaiting[id]
            else Promise.resolve().then(() => poke(id))
        }
        ent.run().then(v => {
            shift()
            ent.resolve(v)
        }, e => {
            shift()
            ent.reject(e)
        })
    }

    function enq<T>(id: string, run: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            let lst = awaiting[id]
            if (!lst) lst = awaiting[id] = []
            lst.push({ resolve, reject, run })
            if (lst.length == 1) poke(id)
        })
    }
    return enq
}

export function lookup<T>(m: SMap<T>, key: string): T {
    if (m.hasOwnProperty(key))
        return m[key]
    return null
}

export class PromiseBuffer<T> {
    private waiting: ((v: (T | Error)) => void)[] = [];
    private available: (T | Error)[] = [];

    drain() {
        for (let f of this.waiting) {
            f(new Error("Promise Buffer Reset"))
        }
        this.waiting = []
        this.available = []
    }


    pushError(v: Error) {
        this.push(v as any)
    }

    push(v: T) {
        let f = this.waiting.shift()
        if (f) f(v)
        else this.available.push(v)
    }

    shiftAsync() {
        if (this.available.length > 0) {
            let v = this.available.shift()
            if (v instanceof Error)
                return Promise.reject<T>(v)
            else
                return Promise.resolve<T>(v)
        } else
            return new Promise<T>((resolve, reject) => {
                let f = (v: (T | Error)) => {
                    if (v instanceof Error) reject(v)
                    else resolve(v)
                }
                this.waiting.push(f)
            })
    }
}

export function formatDate(d: Date) {
    function t(n: number) {
        return ("0" + n).slice(-2)
    }
    return d.getFullYear() + "-" + t(d.getMonth() + 1) + "-" + t(d.getDate())
}

/** Generate a random id consisting of upper and lower case letters */
export function createRandomId(size: number): string {
    let buf = crypto.randomBytes(size * 2)
    let s = buf.toString("base64").replace(/[^a-zA-Z]/g, "");
    if (s.length < size) {
        // this is very unlikely
        return createRandomId(size);
    }
    else {
        return s.substr(0, size);
    }
}

export function sha256(d: string | Buffer) {
    let h = crypto.createHash("sha256")
    h.update(d)
    return h.digest("hex").toLowerCase()
}

export function copyFields(trg: any, src: any) {
    for (let k of Object.keys(src))
        trg[k] = src[k];
}

export function values<T>(v: SMap<T>): T[] {
    let r: T[] = []
    for (let k of Object.keys(v)) {
        r.push(v[k])
    }
    return r
}

export function strcmp(a: string, b: string) {
    if (a == b) return 0;
    if (a < b) return -1;
    return 1;
}

export function checkError(err: Error) {
    if (err) {
        var newOne = new Error(err.message)
        var inner = (<any>err).innerExn || err;
        (<any>newOne).innerExn = inner;
        throw newOne;
    }
}

export function clone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v))
}

export function max(n: number[]) {
    let m = n[0] || 0
    for (let i = 1; i < n.length; ++i)
        if (n[i] > m) m = n[i]
    return m
}

export function min(n: number[]) {
    let m = n[0] || 0
    for (let i = 1; i < n.length; ++i)
        if (n[i] < m) m = n[i]
    return m
}

export function forEachFile(
    dir: string, validPostfix: string, invalidPostfix: string,
    action: (file: string) => void
) {
    fs.readdirSync(dir).forEach(d => {
        if (d.indexOf(validPostfix) == -1)
            return
        if (invalidPostfix && invalidPostfix.length && d.indexOf(invalidPostfix) != -1)
            return
        action(d)
    })
}

export function throwError(code: number) {
    var e = new Error("Error: " + code);
    (<any>e).statusCode = code
    throw e
}

export function etagMatches(req: express.Request, etag: string) {
    let response: express.Response = req._response
    if (!etag) return false
    if (etag[0] != "\"") etag = "\"" + etag + "\""
    if (req.header("if-none-match") == etag) {
        response.status(304)
        response.end()
        return true
    } else {
        response.setHeader("ETag", etag)
        return false
    }
}

export function allowReqCache(req: express.Request) {
    let response: express.Response = req._response
    // 2 years
    response.setHeader("Cache-Control", "public, max-age=63072000")
}

let readAsync = bluebird.promisify(fs.readFile)
export function readTextFileAsync(fn: string) {
    return readAsync(fn)
        .then<string>(buf => buf.toString("utf8"), err => null)
}

const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

export function weekDay(date: string, lang: string) {
    if (!date) return ""
    let d = new Date(date)
    return translate(days[d.getDay()], lang)
}

export function translate(s: string, lang: string) {
    let l = getLocale(lang)
    return lookup(l.translations, s) || s
}

export function monthName(date: string, lang: string) {
    if (!date) return ""
    let d = new Date(date)
    return translate(months[d.getMonth()], lang)
}

export function monthNumber(date: string, lang: string) {
    if (!date) return ""
    let d = new Date(date)
    return ("0" + (d.getMonth() + 1)).slice(-2)
}

export function monthDay(date: string, lang: string) {
    if (!date) return ""
    let d = new Date(date)
    return "" + d.getDate()
}

export function monthPlusDay(date: string, lang: string) {
    let l = getLocale(lang)
    return l.shortdate
        .replace("@day@", monthDay(date, lang))
        .replace("@day0@", ("0" + monthDay(date, lang)).slice(-2))
        .replace("@monthname@", monthName(date, lang))
        .replace("@monthnumber@", monthNumber(date, lang))
}

export function htmlQuote(s: string) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export function expandTemplate(templ: string, vars: any) {
    return templ.replace(/@@(\w+)@@/g, (f, v) =>
        htmlQuote((vars[v] || "") + ""))
}

export function expandTemplateList(templ: string, objs: any[]) {
    return objs.map(e => expandTemplate(templ, e)).join("\n")
}

export function fullDate(s: string, lang: string) {
    return weekDay(s, lang) + " " + monthPlusDay(s, lang)
}

export class Cache<T> {
    cache: SMap<T> = {}
    size = 0
    get(key: string) {
        if (!key) return null
        if (this.cache.hasOwnProperty(key))
            return this.cache[key]
        return null
    }

    set(key: string, v: T, sz: number) {
        if (!key) return
        delete this.cache[key]
        if (!v || sz > maxCacheEltSize) return
        if (this.size + sz > maxCacheSize) {
            this.flush()
        }
        this.size += sz
        this.cache[key] = v
    }

    flush() {
        this.size = 0
        this.cache = {}
    }
}


export class StringCache extends Cache<string> {
    set(key: string, v: string, sz?: number) {
        if (!sz) sz = 100 + v.length * 2
        super.set(key, v, sz)
    }
}


export function reqSetup(req: express.Request) {
    let res: express.Response = req._response

    if (req.query["setlang"] != null) {
        let ln = req.query['setlang'] || ""
        delete req.query["setlang"]
        let qs2 = querystring.stringify(req.query)
        res.cookie("GWLANG", ln)
        res.redirect(req.path + (qs2 ? "?" + qs2 : ""))
        return false
    }

    let langs: string[] = []
    let addLang = (s: string) => {
        if (!s) return
        s = s.toLowerCase()
        let m = /^([a-z]+)(-[a-z]+)?/.exec(s)
        if (m) {
            let full = m[0]
            if (langs.indexOf(full) >= 0) return
            langs.push(full)
            if (m[1] != full)
                langs.push(m[1])
        }
    }

    addLang(req.query["lang"])
    addLang(req.cookies['GWLANG'])
    for (let s of (req.header("Accept-Language") || "").split(",")) {
        let headerLang = (/^\s*([A-Za-z\-]+)/.exec(s) || [])[1];
        addLang(headerLang)
    }

    req.langs = langs
    return true
}


