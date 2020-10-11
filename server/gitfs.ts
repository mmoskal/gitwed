import fs = require("fs")
import crypto = require("crypto")
import tools = require("./tools")
import logs = require("./logs")
import * as child_process from "child_process";
import * as bluebird from "bluebird";
import winston = require('winston');
import rest = require('./rest');

const gitRefreshTimeoutSeconds = 120


export interface OAuthConfig {
    "client_id": string
    "client_secret": string
    "auth_uri": string // URL for initiating the login process; "https://example.com/oauth2/authorize/",
    "token_uri": string // URL for swapping code for token; "https://example.com/oauth2/token/",
    "redirect_uris": string[] // list of URLs on current domain; first one will be used; "https://here.com/oauth"
    "userinfo_uri": string // URL to get info about the user; "https://example.com/api/v1/users/me/"

    userValidUntil: string
    idTokenValidField: string // check for this field in id_token
    userInvalidPage: string // send user here, if the user account is invalid
}

export interface Config {
    jwtSecret: string;
    justDir?: boolean;
    repoPath?: string;
    eventsRepoPath?: string;
    sideRepos?: SMap<string>;
    mailgunApiKey?: string;
    sendgridApiKey?: string;
    gmapsKey?: string;
    mailgunDomain?: string;
    authDomain?: string;
    networkInterface?: string;
    serviceName?: string;
    proxy?: boolean;
    cdnPath?: string;
    production?: boolean;
    vhosts?: SMap<string>;
    certEmail?: string;
    defaultRedirect?: string; // defaults to /events/
    allowedEmailRecipients?: string[];
    services?: rest.ServiceConfig[];
    roSecret?: string;
    eventSecret?: string;
    oauth?: OAuthConfig;
}

export let config: Config

interface GitObject {
    id: string;
    type: string;
    memsize: number;
    data: Buffer;
    tree?: TreeEntry[];
    commit?: Commit;
}

interface Commit {
    tree: string;
    parents: string[];
    author: string;
    date: number;
    msg: string;
}

export interface TreeEntry {
    mode: string;
    name: string;
    sha: string;
}

export interface LogEntry {
    id: string;
    author: string;
    date: number;
    files: string[];
    msg: string;
}

export interface GitFs {
    pokeAsync: (force?: boolean) => Promise<void>;
    logAsync: (path?: string) => Promise<LogEntry[]>;

    getFileAsync: (name: string, ref?: string) => Promise<Buffer>;
    getTextFileAsync: (name: string, ref?: string) => Promise<string>;
    getTreeAsync(path: string, ref: string): Promise<TreeEntry[]>;

    setTextFileAsync: (name: string, val: string, msg: string, user: string) => Promise<void>;
    setJsonFileAsync: (name: string, val: {}, msg: string, user: string) => Promise<void>;
    setBinFileAsync: (name: string, val: Buffer, msg: string, useremail: string) => Promise<void>;
    createBinFileAsync: (dir: string, basename: string, ext: string, buf: Buffer, msg: string, user: string) => Promise<string>;
    onUpdate: (f: (isPull: boolean) => void) => void;

    path: string;
    id: string;
}

export let main: GitFs;
export let events: GitFs;
export let repos: SMap<GitFs> = {};

export let gwcdnByName: SMap<string> = {}
export let gwcdnBySHA: SMap<string> = {}
let gwcdnDir = "gwcdn/"

const repoByDirCache: SMap<GitFs> = {}
export function findRepo(path: string): GitFs {
    let p0 = path.split('/').filter(s => !!s)[0]
    if (!p0 || p0[0] == '.') return main
    let curr = tools.lookup(repoByDirCache, p0)
    if (curr) return curr
    for (let r of tools.values(repos)) {
        if (fs.existsSync(r.path + "/" + p0)) {
            repoByDirCache[p0] = r
            return r
        }
    }
    return main
}

function join(a: string, b: string) {
    return a.replace(/\/+$/, "") + "/" + b.replace(/^\/+/, "")
}

const readAsync: (fn: string) => Promise<Buffer> = bluebird.promisify(fs.readFile) as any
const writeAsync: (fn: string, v: Buffer | string) => Promise<void> = bluebird.promisify(fs.writeFile) as any
const readdirAsync = bluebird.promisify(fs.readdir)

export function githash(buf: Buffer) {
    let h = crypto.createHash("sha1")
    h.update("blob " + buf.length + "\u0000")
    h.update(buf)
    return h.digest("hex")
}

export function splitName(fullname: string) {
    let m = /(.*)\/([^\/]+)/.exec(fullname)
    let parent: string = null
    let name = ""
    if (!m) {
        if (fullname == "/") { }
        else if (fullname.indexOf("/") == -1) {
            parent = "/"
            name = fullname
        } else {
            throw new Error("bad name")
        }
    } else {
        parent = m[1] || "/"
        name = m[2]
    }
    return { parent, name }
}

function parseTree(buf: Buffer) {
    let entries: TreeEntry[] = []
    let ptr = 0
    while (ptr < buf.length) {
        let start = ptr
        while (48 <= buf[ptr] && buf[ptr] <= 55)
            ptr++
        if (buf[ptr] != 32)
            throw new Error("bad tree format")
        let mode = buf.slice(start, ptr).toString("utf8")
        ptr++
        start = ptr
        while (buf[ptr])
            ptr++
        if (buf[ptr] != 0)
            throw new Error("bad tree format 2")
        let name = buf.slice(start, ptr).toString("utf8")
        ptr++
        let sha = buf.slice(ptr, ptr + 20).toString("hex")
        ptr += 20
        if (ptr > buf.length)
            throw new Error("bad tree format 3")
        entries.push({ mode, name, sha })
    }
    return entries
}

function parseCommit(buf: Buffer): Commit {
    let cmt = buf.toString("utf8")
    let mtree = /^tree (\S+)/m.exec(cmt)
    let mpar = /^parent (.+)/m.exec(cmt)
    let mauthor = /^author (.+) (\d+) ([+\-]\d{4})$/m.exec(cmt)
    let midx = cmt.indexOf("\n\n")
    return {
        tree: mtree[1],
        parents: mpar[1].split(/\s+/),
        author: mauthor[1],
        date: parseInt(mauthor[2]),
        msg: cmt.slice(midx + 2)
    }
}


function parseLog(fulllog: string) {
    let entries: LogEntry[] = []
    let currEntry: LogEntry
    let newEntry = () => {
        if (currEntry) entries.push(currEntry)
        currEntry = {
            id: "",
            author: "",
            date: 0,
            files: [],
            msg: "",
        }
    }
    for (let l of fulllog.split("\n")) {
        let m = /^commit (\S+)/.exec(l)
        if (m) {
            newEntry()
            currEntry.id = m[1]
        } else if (l.slice(0, 4) == "    ") {
            currEntry.msg += l.slice(4) + "\n"
        } else {
            m = /^([A-Za-z]+):\s*(.*)/.exec(l)
            if (m && m[1] == "Author")
                currEntry.author = m[2]
            else if (m && m[1] == "AuthorDate")
                currEntry.date = Math.round(new Date(m[2]).getTime() / 1000)
            else {
                m = /^[A-Z]\t(.*)/.exec(l)
                if (m) currEntry.files.push(m[1])
            }
        }
    }
    newEntry()
    return entries
}

let shutdownQueue: (() => Promise<void>)[] = []

export function shutdown() {
    winston.info("shut down commanced")
    Promise.all(shutdownQueue.map(f => f()))
        .then(() => {
            winston.info("exiting...")
            process.exit(0)
        })
}

export async function mkGitFsAsync(id: string, repoPath: string): Promise<GitFs> {
    let gitCatFile: child_process.ChildProcess
    let lastUsage = 0
    let gitCatFileBuf = new tools.PromiseBuffer<Buffer>()
    let justDir = !!config.justDir
    let apiLockAsync = tools.promiseQueue()
    let rootId = ""
    let gitCache = new tools.Cache<GitObject>()
    let syncRunning = false
    let pushNeeded = 0
    let lastRequestTime = 0
    let lastSyncTime = 0
    let onUpdate: ((isPull: boolean) => void)[] = []

    repoPath = repoPath.replace(/\/$/, "") + "/"

    let iface: GitFs = {
        pokeAsync,
        getFileAsync,
        getTextFileAsync,
        getTreeAsync,
        setTextFileAsync,
        setJsonFileAsync,
        setBinFileAsync,
        createBinFileAsync,
        logAsync,
        onUpdate: f => onUpdate.push(f),
        path: repoPath,
        id: id
    }

    shutdownQueue.push(shutdownAsync)

    if (config.production) {
        await getHeadRevAsync()
    } else {
        await statusCleanAsync()
        await pullAsync()

        if (!justDir)
            setInterval(() => {
                maybeSyncAsync()
            }, 15 * 60 * 1000)
    }

    repos[iface.id] = iface
    return iface

    async function getTextFileAsync(name: string, ref = "master"): Promise<string> {
        let buf = await getFileAsync(name, ref)
        return buf.toString("utf8")
    }

    function setTextFileAsync(name: string, val: string, msg: string, user: string) {
        return setBinFileAsync(name, Buffer.from(val, "utf8"), msg, user)
    }

    function setJsonFileAsync(name: string, val: {}, msg: string, user: string) {
        return setBinFileAsync(name, Buffer.from(JSON.stringify(val, null, 4), "utf8"), msg, user)
    }

    function logAsync(path = ".") {
        return apiLockAsync("log", () =>
            runGitAsync(["log", "--name-status", "--pretty=fuller", "--max-count=200", path])
                .then(buf => parseLog(buf)))
    }

    function pokeAsync(force = false) {
        lastRequestTime = Date.now()
        if (force) {
            lastSyncTime = 0
        }
        return maybeSyncAsync()
    }

    function shutdownAsync() {
        winston.info("shutting down: " + repoPath)
        gcGitCatFile()
        return apiLockAsync("commit", () => {
            gcGitCatFile()
            return Promise.resolve()
        })
    }


    function maybeSyncAsync() {
        if (syncRunning) return Promise.resolve()
        let now = Date.now()
        if (pushNeeded || now - lastSyncTime > gitRefreshTimeoutSeconds * 1000) {
            lastSyncTime = now
            syncRunning = true
            return apiLockAsync("commit", () =>
                pullAsync()
                    .then(() => {
                        if (pushNeeded) {
                            let v = pushNeeded
                            winston.info("pushing...")
                            return runGitAsync(["push", "--quiet"])
                                .then(() => {
                                    pushNeeded -= v
                                    return getHeadRevAsync()
                                })
                        } else {
                            return Promise.resolve()
                        }
                    })
                    .then(() => {
                        syncRunning = false
                    }, err => {
                        syncRunning = false
                        logs.logError(err)
                    }))
        }
        return Promise.resolve()
    }

    // export 
    function createBinFileAsync(dir: string, basename: string, ext: string, buf: Buffer,
        msg: string, user: string
    ) {
        let fspath = repoPath + dir + "/"
        tools.mkdirP(fspath)
        let ents = fs.readdirSync(fspath)
        for (let bn of ents) {
            let st = fs.statSync(fspath + bn)
            if (st.size == buf.length) {
                let buf0 = fs.readFileSync(fspath + bn)
                if (buf0.equals(buf)) {
                    return Promise.resolve(bn)
                }
            }
        }

        let fn = basename + ext
        if (ents.indexOf(fn) >= 0) {
            let no = 1
            while (ents.indexOf(basename + "-" + no + ext) >= 0)
                no++
            fn = basename + "-" + no + ext
        }

        // write it, so we get a lock on the name
        fs.writeFileSync(fspath + fn, buf)

        // this will write the file again
        return setBinFileAsync(dir + "/" + fn, buf, msg, user)
            .then(() => fn)
    }

    // export    
    function getFileAsync(name: string, ref = "master"): Promise<Buffer> {
        name = name.replace(/^\/+/, "")
        let m = /^gw\/(.*)/.exec(name)
        if (m)
            return readAsync("gw/" + m[1])
                .then(v => v, err => readAsync("built/gw/" + m[1]))
                .then(v => v, err => readAsync("node_modules/gitwed/gw/" + m[1]))
                .then(v => v, err => readAsync("node_modules/gitwed/built/gw/" + m[1]))

        m = /^gwcdn\/(.*)/.exec(name)
        if (m)
            return readAsync(gwcdnDir + m[1])

        if (ref == "SHA") {
            let fn = tools.lookup(gwcdnBySHA, name)
            if (fn) {
                return readAsync(gwcdnDir + fn)
            }
        }

        if (ref == "master")
            return readAsync(repoPath + name)
        return getGitObjectAsync(ref == "SHA" ? name : ref + ":" + name)
            .then(obj => {
                if (obj.type == "blob") {
                    return obj.data
                } else {
                    throw new Error("not found")
                }
            })
    }

    function getHeadRevAsync() {
        return Promise.resolve()
            .then(() => runGitAsync(["rev-parse", "HEAD"]))
            .then(buf => {
                rootId = buf.trim()
                onUpdate.forEach(f => f(false))
                winston.debug(`HEAD now at ${rootId}`)
            })
    }

    function pullAsync() {
        if (justDir)
            return getHeadRevAsync()
        let id = rootId
        return Promise.resolve()
            .then(() => runGitAsync(["pull", "--strategy=recursive", "--strategy-option=ours", "--no-edit", "--quiet"]))
            .then(getHeadRevAsync)
            .then(() => {
                if (id == rootId)
                    winston.info(`empty pull at ${rootId}`)
                else {
                    onUpdate.forEach(f => f(true))
                    winston.info(`git pull: ${id} -> ${rootId}`)
                }
            })
    }

    function maybeGcGitCatFile() {
        if (!gitCatFile) return
        let d = Date.now() - lastUsage
        if (d < 3000) return
        winston.debug("[gc] git cat-file")
        gitCatFile.stdin.end()
        gitCatFile = null
        gitCatFileBuf.drain()
    }

    function gcGitCatFile() {
        lastUsage = 1
        maybeGcGitCatFile()
    }

    function startGitCatFile() {
        if (!lastUsage) {
            setInterval(maybeGcGitCatFile, 1000)
        }
        lastUsage = Date.now()
        if (!gitCatFile) {
            winston.debug("[run] git cat-file --batch")
            gitCatFile = child_process.spawn("git", ["cat-file", "--batch"], {
                cwd: repoPath,
                env: process.env,
                stdio: "pipe",
                shell: false
            })
            gitCatFile.stderr.setEncoding("utf8")
            gitCatFile.stderr.on('data', (msg: string) => {
                winston.error("[git cat-file error] " + msg)
            })
            gitCatFile.stdout.on('data', (buf: Buffer) => gitCatFileBuf.push(buf))
        }
    }


    function getGitObjectAsync(id: string) {
        if (!id || /[\r\n]/.test(id))
            throw new Error("bad id: " + id)

        let cached = gitCache.get(id)
        if (cached)
            return Promise.resolve(cached)

        return apiLockAsync("cat-file", () => {
            // check again, maybe the object has been cached while we were waiting
            cached = gitCache.get(id)
            if (cached)
                return Promise.resolve(cached)

            winston.debug("cat: " + id)

            startGitCatFile()
            gitCatFile.stdin.write(id + "\n")
            let sizeLeft = 0
            let bufs: Buffer[] = []
            let res: GitObject = {
                id: id,
                type: "",
                memsize: 64,
                data: null
            }
            let typeBuf: Buffer = null
            let loop = (): Promise<GitObject> =>
                gitCatFileBuf.shiftAsync()
                    .then(buf => {
                        startGitCatFile() // make sure the usage counter is updated
                        if (!res.type) {
                            winston.debug(`cat-file ${id} -> ${buf.length} bytes; ${buf[0]} ${buf[1]}`)
                            if (typeBuf) {
                                buf = Buffer.concat([typeBuf, buf])
                                typeBuf = null
                            } else {
                                while (buf[0] == 10)
                                    buf = buf.slice(1)
                            }
                            let end = buf.indexOf(10)
                            winston.debug(`len-${buf.length} pos=${end}`)
                            if (end < 0) {
                                if (buf.length == 0) {
                                    // skip it
                                } else {
                                    typeBuf = buf
                                }
                                winston.info(`retrying read; sz=${buf.length}`)
                                return loop()
                            }
                            let line = buf
                            if (end >= 0) {
                                line = buf.slice(0, end)
                                buf = buf.slice(end + 1)
                            } else {
                                throw new Error("bad cat-file respose: " + buf.toString("utf8").slice(0, 100))
                            }
                            let lineS = line.toString("utf8")
                            if (/ missing/.test(lineS)) {
                                throw new Error("file missing")
                            }
                            let m = /^([0-9a-f]{40}) (\S+) (\d+)/.exec(lineS)
                            if (!m)
                                throw new Error("invalid cat-file response: "
                                    + lineS + " <nl> " + buf.toString("utf8"))
                            res.id = m[1]
                            res.type = m[2]
                            sizeLeft = parseInt(m[3])
                            res.memsize += sizeLeft // approximate
                        }
                        if (buf.length > sizeLeft) {
                            buf = buf.slice(0, sizeLeft)
                        }
                        bufs.push(buf)
                        sizeLeft -= buf.length
                        if (sizeLeft <= 0) {
                            res.data = Buffer.concat(bufs)
                            return res
                        } else {
                            return loop()
                        }
                    })

            return loop().then(obj => {
                winston.debug(`[cat-file] ${id} -> ${obj.id} ${obj.type} ${obj.data.length}`)
                if (obj.type == "tree") {
                    obj.tree = parseTree(obj.data)
                    obj.data = null
                } else if (obj.type == "commit") {
                    obj.commit = parseCommit(obj.data)
                    obj.data = null
                }

                // check if this is an object in a specific revision, not say on 'master'
                // and if it's small enough to warant caching
                if (/^[0-9a-f]{40}/.test(id)) {
                    gitCache.set(id, obj, obj.memsize)
                }

                return obj
            })
        })
    }

    // export
    function getTreeAsync(path: string, ref: string): Promise<TreeEntry[]> {
        if (ref == "HEAD" || ref == "master") ref = rootId
        if (!/^[0-9a-f]{40}$/.test(ref))
            throw new Error("bad ref: " + ref)
        if (path == "/")
            return getGitObjectAsync(ref)
                .then(obj => {
                    if (obj.type != "commit")
                        throw new Error("bad type")
                    return getGitObjectAsync(obj.commit.tree)
                        .then(o => o.tree)
                })

        let spl = splitName(path.replace(/\/$/, ""))
        return getTreeAsync(spl.parent, ref)
            .then(ents => {
                if (!ents)
                    return null
                let e = ents.find(x => x.name == spl.name)
                if (!e)
                    return null
                return getGitObjectAsync(e.sha)
                    .then(o => o.tree)
            })
    }

    function runGitAsync(args: string[]) {
        let info = "git " + args.join(" ")
        winston.debug("[run] " + info)
        return new Promise<string>((resolve, reject) => {
            let ch = child_process.spawn("git", args, {
                cwd: repoPath,
                env: process.env,
                stdio: "pipe",
                shell: false
            })
            let outbufs: Buffer[] = []
            let errbufs: Buffer[] = []
            ch.stdin.end()
            ch.stderr.on('data', (buf: Buffer) => {
                errbufs.push(buf)
            })
            ch.stdout.on('data', (buf: Buffer) => {
                outbufs.push(buf)
            })
            ch.on('close', (code: number) => {
                if (errbufs.length)
                    winston.info(Buffer.concat(errbufs).toString("utf8").trim())
                if (code != 0) {
                    reject(new Error("Exit code: " + code + " from " + info))
                }
                resolve(Buffer.concat(outbufs).toString("utf8"))
            });
        })
    }

    // export 
    function setBinFileAsync(name: string, val: Buffer, msg: string, useremail: string) {
        name = name.replace(/^\/+/, "")
        return apiLockAsync("commit", async () => {
            winston.info(`write file ${name} ${val.length} bytes; msg: ${msg}; author: ${useremail}`)
            let spl = splitName(name)
            tools.mkdirP(repoPath + spl.parent)
            await writeAsync(repoPath + name, val)

            if (justDir)
                return

            let uname = useremail.replace(/@.*/, "")

            await runGitAsync(["add", name])
            await runGitAsync([
                "-c", "user.name=" + uname,
                "-c", "user.email=" + useremail,
                "commit",
                "-m", msg])
            await getHeadRevAsync()

            pushNeeded++
            // run in background
            maybeSyncAsync()
        })
    }

    function statusCleanAsync() {
        if (justDir)
            return Promise.resolve()

        return runGitAsync(["status", "--porcelain", "--untracked-files"])
            .then(outp => {
                if (outp.trim()) {
                    winston.error(`git status output:\n${outp}`)
                    throw new Error("git not clean")
                }
            })
    }

}

function readGWCDN() {
    let ndir = "node_modules/gitwed/gwcdn/"
    if (fs.existsSync(ndir))
        gwcdnDir = ndir
    for (let fn of fs.readdirSync(gwcdnDir)) {
        let sha = githash(fs.readFileSync(gwcdnDir + fn))
        gwcdnByName[fn] = sha
        gwcdnBySHA[sha] = fn
    }
}

export async function initAsync(cfg: Config) {
    readGWCDN()
    config = cfg
    main = await mkGitFsAsync("main", cfg.repoPath)
    if (cfg.eventsRepoPath)
        events = await mkGitFsAsync("events", cfg.eventsRepoPath)
    let s = cfg.sideRepos || {}
    for (let k of Object.keys(s)) {
        await mkGitFsAsync(k, s[k])
    }
}
