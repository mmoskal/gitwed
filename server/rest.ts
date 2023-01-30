import tools = require("./tools")
import * as winston from "winston"

export interface ServiceConfig {
    id: string
    format: string
    oauthURL?: string
    oauthClientID?: string
    oauthClientSecret?: string
}

interface CacheEntry {
    expTime: number
    data: SMap<string>
}

interface TokenResp {
    access_token: string
    token_type: string // 'Bearer',
    expires_in: number // 3600,
    scope: string
}

function flatten(r: SMap<string>, pref: string, dict: any) {
    if (Array.isArray(dict)) {
        let arr = dict as any[]
        for (let i = 0; i < arr.length; ++i) {
            flatten(r, pref + i, arr[i])
        }
    } else {
        if (typeof dict == "number" || typeof dict == "boolean")
            dict = dict + ""
        if (dict == null) dict = ""
        if (typeof dict == "string") {
            r[pref] = dict
            return
        }

        let n = 0
        if (pref) pref += "."
        for (let k of Object.keys(dict)) {
            let v = dict[k]
            if (k.length == 32 && /[0-9]/.test(k) && /^[a-f0-9]+$/.test(k)) {
                k = n + ""
                n++
            }
            flatten(r, pref + k, v)
        }
    }
}

export class Service {
    private token: string
    private tokenExp: number
    private cache: SMap<CacheEntry> = {}

    constructor(public config: ServiceConfig) {}

    async expandAsync(e: Cheerio) {
        let url = this.config.format.replace(/\{(\w+)\}/g, (f, id: string) => {
            return e.attr(id.toLowerCase()) || "<" + id + ">"
        })

        let c = this.cache[url]
        if (!c || c.expTime < Date.now()) {
            await this.refreshTokenAsync()
            winston.info("query: " + url)
            let resp = await tools.requestAsync({
                url,
                headers: {
                    Authorization: this.token,
                },
                allowHttpErrors: true,
            })
            c = {
                expTime: Date.now() + 5 * 60 * 1000,
                data: {},
            }
            if (resp.statusCode == 200) flatten(c.data, "", resp.json)
            else {
                c.data = {
                    status: resp.statusCode + "",
                    msg: resp.text,
                }
            }
            c.data["JSON"] = JSON.stringify(c.data, null, 4)
            this.cache[url] = c
        }

        let nhtml = e.html().replace(/@@([\w\.]+)@@/g, (f, id: string) => {
            return c.data[id] || ""
        })

        e.html(nhtml)
        e.replaceWith(e[0].childNodes)
    }

    async refreshTokenAsync() {
        if (!this.config.oauthURL) return
        let now = Date.now()
        if (this.token && this.tokenExp < now) return
        winston.info("authorize at " + this.config.oauthURL)
        let resp = await tools.requestAsync({
            url: this.config.oauthURL,
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            method: "POST",
            data:
                "grant_type=client_credentials" +
                "&client_id=" +
                this.config.oauthClientID +
                "&client_secret=" +
                this.config.oauthClientSecret,
        })
        let r = resp.json as TokenResp
        this.token = r.token_type + " " + r.access_token
        this.tokenExp = Date.now() + r.expires_in * 700
        return
    }
}

let serv: SMap<Service> = {}

export function init(services: ServiceConfig[]) {
    for (let s of services) {
        serv[s.id] = new Service(s)
    }
}

export function expandAsync(e: Cheerio) {
    let id = e.attr("service")
    let s = serv[id]
    if (!s) return Promise.resolve()
    return s.expandAsync(e)
}
