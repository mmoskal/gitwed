import fs = require("fs")
import tools = require("./tools")

interface Config {
    gitlabUrl: string;
    gitlabToken: string;
    gitlabProjectId: number;
}

let config: Config = JSON.parse(fs.readFileSync("config.json", "utf8"))
let gitlab = require("gitlab")({
    url: config.gitlabUrl,
    token: config.gitlabToken
})

function join(a:string,b:string) {
    return a.replace(/\/+$/, "") + "/" + b.replace(/^\/+/, "")
}

function requestAsync(opts:tools.HttpRequestOptions) {
    if (!opts.headers) opts.headers = {}
    opts.headers["PRIVATE-TOKEN"] = config.gitlabToken
    if(!/^https?:/.test(opts.url)) {
        opts.url = join(join(config.gitlabUrl, "api/v3"), opts.url)
    }
    return tools.requestAsync(opts)
}

export function existsAsync(name: string) {
    return Promise.resolve(fs.existsSync("html/" + name))
}

let readAsync = Promise.promisify(fs.readFile)
let writeAsync: any = Promise.promisify(fs.writeFile)

export function getTextFileAsync(name: string) {
    return readAsync("html/" + name).then(b => b.toString("utf8"))
}

export function setTextFileAsync(name: string, val: string) {
    return writeAsync("html/" + name, val)
}