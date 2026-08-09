import fs = require("fs")
import path = require("path")
import crypto = require("crypto")
import tools = require("./tools")
import logs = require("./logs")
import * as child_process from "child_process"
import * as bluebird from "bluebird"
import winston = require("winston")
import rest = require("./rest")

const gitRefreshTimeoutSeconds = 120

export interface OAuthConfig {
    client_id: string
    client_secret: string
    auth_uri: string // URL for initiating the login process; "https://example.com/oauth2/authorize/",
    token_uri: string // URL for swapping code for token; "https://example.com/oauth2/token/",
    redirect_uris: string[] // list of URLs on current domain; first one will be used; "https://here.com/oauth"
    userinfo_uri: string // URL to get info about the user; "https://example.com/api/v1/users/me/"
    logout_uri?: string
    userinfo_condition?: string // JS boolean expression taking 'me' as free variable argument
    scopes?: string

    userInvalidPage: string // send user here, if the user account is invalid

    secondaryRedirs: string[]
    secondaryTokenFields?: string[]
    secondaryKey: string
}

export interface Config {
    jwtSecret: string
    justDir?: boolean
    repoPath?: string
    eventsRepoPath?: string
    sideRepos?: SMap<string>
    vhostRedirs?: SMap<string>
    mailgunApiKey?: string
    sendgridApiKey?: string
    gmapsKey?: string
    mailgunDomain?: string
    authDomain?: string
    networkInterface?: string
    serviceName?: string
    proxy?: boolean
    cdnPath?: string
    production?: boolean
    vhosts?: SMap<string>
    certEmail?: string
    defaultRedirect?: string // defaults to /events/
    allowedEmailRecipients?: string[]
    services?: rest.ServiceConfig[]
    roSecret?: string
    eventSecret?: string
    oauth?: OAuthConfig
}

export let config: Config

interface GitObject {
    id: string
    type: string
    memsize: number
    data: Buffer
    tree?: TreeEntry[]
    commit?: Commit
}

interface Commit {
    tree: string
    parents: string[]
    author: string
    date: number
    msg: string
}

export interface TreeEntry {
    mode: string
    name: string
    sha: string
}

export interface LogEntry {
    id: string
    author: string
    date: number
    files: string[]
    msg: string
}

export interface GitFs {
    pokeAsync: (force?: boolean) => Promise<void>
    logAsync: (path?: string) => Promise<LogEntry[]>

    getFileAsync: (name: string, ref?: string) => Promise<Buffer>
    getTextFileAsync: (name: string, ref?: string) => Promise<string>
    getTreeAsync(path: string, ref: string): Promise<TreeEntry[]>

    setTextFileAsync: (
        name: string,
        val: string,
        msg: string,
        user: string
    ) => Promise<void>
    setJsonFileAsync: (
        name: string,
        val: {},
        msg: string,
        user: string
    ) => Promise<void>
    setBinFileAsync: (
        name: string,
        val: Buffer,
        msg: string,
        useremail: string
    ) => Promise<void>
    replaceBinFileAsync: (
        name: string,
        val: Buffer,
        msg: string,
        useremail: string
    ) => Promise<void>
    createBinFileAsync: (
        dir: string,
        basename: string,
        ext: string,
        buf: Buffer,
        msg: string,
        user: string
    ) => Promise<string>
    onUpdate: (f: (isPull: boolean) => void) => void

    path: string
    id: string
}

export let main: GitFs
export let events: GitFs
export let repos: SMap<GitFs> = {}

export let gwcdnByName: SMap<string> = {}
export let gwcdnBySHA: SMap<string> = {}
let gwcdnDir = "gwcdn/"

const repoByDirCache: SMap<GitFs> = {}
export function findRepo(path: string): GitFs {
    let p0 = path.split("/").filter(s => !!s)[0]
    if (!p0 || p0[0] == ".") return main
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

const readAsync: (fn: string) => Promise<Buffer> = bluebird.promisify(
    fs.readFile
) as any
const readFdAsync: (fd: number) => Promise<Buffer> = bluebird.promisify(
    fs.readFile
) as any
const writeFdAsync: (fd: number, v: Buffer | string) => Promise<void> =
    bluebird.promisify(fs.writeFile) as any
const truncateFdAsync: (fd: number, len: number) => Promise<void> =
    bluebird.promisify(fs.ftruncate) as any
const closeAsync: (fd: number) => Promise<void> = bluebird.promisify(
    fs.close
) as any
const readdirAsync = bluebird.promisify(fs.readdir)

let secureWriteBeforeOpenTestHook: ((name: string) => void) | null = null
let secureReadBeforeOpenTestHook: ((name: string) => void) | null = null
let bundledAssetRootAfterValidationTestHook: ((root: string) => void) | null =
    null

interface BundledAssetRootIdentity {
    path: string
    dev: number
    ino: number
}

interface BundledAssetRootSnapshot {
    root: string
    identities: BundledAssetRootIdentity[]
}

// This is intentionally synchronous so tests can deterministically exercise the
// otherwise tiny pathname-validation/open race without affecting production.
export function setSecureWriteBeforeOpenTestHook(
    hook: ((name: string) => void) | null
) {
    secureWriteBeforeOpenTestHook = hook
}

export function setSecureReadBeforeOpenTestHook(
    hook: ((name: string) => void) | null
) {
    secureReadBeforeOpenTestHook = hook
}

export function setBundledAssetRootAfterValidationTestHook(
    hook: ((root: string) => void) | null
) {
    bundledAssetRootAfterValidationTestHook = hook
}

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
        if (fullname == "/") {
        } else if (fullname.indexOf("/") == -1) {
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
        while (48 <= buf[ptr] && buf[ptr] <= 55) ptr++
        if (buf[ptr] != 32) throw new Error("bad tree format")
        let mode = buf.slice(start, ptr).toString("utf8")
        ptr++
        start = ptr
        while (buf[ptr]) ptr++
        if (buf[ptr] != 0) throw new Error("bad tree format 2")
        let name = buf.slice(start, ptr).toString("utf8")
        ptr++
        let sha = buf.slice(ptr, ptr + 20).toString("hex")
        ptr += 20
        if (ptr > buf.length) throw new Error("bad tree format 3")
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
        msg: cmt.slice(midx + 2),
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
            if (m && m[1] == "Author") currEntry.author = m[2]
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
    Promise.all(shutdownQueue.map(f => f())).then(() => {
        winston.info("exiting...")
        process.exit(0)
    })
}

export async function mkGitFsAsync(
    id: string,
    repoPath: string
): Promise<GitFs> {
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
    const repoRoot = fs.realpathSync(repoPath.slice(0, -1))

    type WriteMode = "create" | "replace" | "upsert"

    interface FileIdentity {
        dev: number
        ino: number
    }

    interface DirectorySnapshot {
        name: string
        directory: string
        identities: FileIdentity[]
    }

    function invalidWritePath(message: string): Error {
        return new Error("Invalid repository write path: " + message)
    }

    function invalidReadPath(message: string): Error {
        return new Error("Invalid repository read path: " + message)
    }

    function directoryReadError(name: string): NodeJS.ErrnoException {
        const error: NodeJS.ErrnoException = new Error(
            "EISDIR: illegal operation on a directory, read: " + name
        )
        error.code = "EISDIR"
        return error
    }

    function replacementTargetNotFound(name: string): Error {
        const error: any = new Error(
            "Invalid repository write path: replacement target does not exist: " +
                name
        )
        error.statusCode = 404
        error.code = "ENOENT"
        return error
    }

    function normalizeWritePath(name: string, allowEmpty = false): string {
        if (
            typeof name != "string" ||
            /[\\\0\r\n]/.test(name) ||
            name.startsWith("//") ||
            /^[a-zA-Z]:/.test(name)
        )
            throw invalidWritePath(name + "")

        // A leading slash has historically meant "from the repository root".
        // Strip that logical marker; never pass an absolute path to fs or git.
        if (name[0] == "/") name = name.slice(1)
        if (!name && allowEmpty) return ""

        const parts = name.split("/")
        if (
            !name ||
            parts.some(
                part =>
                    !part ||
                    part == "." ||
                    part == ".." ||
                    /[\x00-\x1f\x7f]/.test(part)
            )
        )
            throw invalidWritePath(name)
        return parts.join("/")
    }

    function containedPath(name: string): string {
        const target = path.resolve(repoRoot, name)
        if (target != repoRoot && !target.startsWith(repoRoot + path.sep))
            throw invalidWritePath(name)
        return target
    }

    function normalizeSpecialReadPath(name: string): string {
        if (
            typeof name != "string" ||
            !name ||
            /[\\\0\r\n]/.test(name) ||
            /%(?:2e|2f|5c)/i.test(name) ||
            name.startsWith("/") ||
            /^[a-zA-Z]:/.test(name)
        )
            throw invalidReadPath(name + "")

        const parts = name.split("/")
        if (
            parts.some(
                part =>
                    !part ||
                    part == "." ||
                    part == ".." ||
                    /[\x00-\x1f\x7f]/.test(part)
            )
        )
            throw invalidReadPath(name)
        return parts.join("/")
    }

    function containedReadPath(name: string, root = repoRoot): string {
        const target = path.resolve(root, name)
        if (target != root && !target.startsWith(root + path.sep))
            throw invalidReadPath(name)

        return target
    }

    function readDirectorySnapshot(
        target: string,
        name: string,
        root = repoRoot
    ): DirectorySnapshot {
        const directory = target == root ? root : path.dirname(target)
        const relative = path.relative(root, directory)
        if (relative == ".." || relative.startsWith(".." + path.sep))
            throw invalidReadPath(name)

        let current = root
        const identities: FileIdentity[] = []
        const recordDirectory = (candidate: string) => {
            const stat = fs.lstatSync(candidate)
            if (stat.isSymbolicLink())
                throw invalidReadPath(
                    "path contains a symbolic link: " + name
                )
            if (!stat.isDirectory()) throw invalidReadPath(name)
            identities.push({ dev: stat.dev, ino: stat.ino })
        }

        recordDirectory(current)
        for (const part of relative.split(path.sep).filter(part => !!part)) {
            current = path.join(current, part)
            recordDirectory(current)
        }
        return { name, directory, identities }
    }

    function verifyReadDirectorySnapshot(
        target: string,
        expected: DirectorySnapshot,
        root = repoRoot
    ) {
        const actual = readDirectorySnapshot(target, expected.name, root)
        if (
            actual.identities.length != expected.identities.length ||
            actual.identities.some(
                (identity, index) =>
                    !sameIdentity(identity, expected.identities[index])
            )
        )
            throw invalidReadPath(expected.name)
    }

    async function secureReadFileAsync(
        name: string,
        root = repoRoot,
        invokeTestHook = true,
        verifyRoot: (() => void) | null = null
    ): Promise<Buffer> {
        if (verifyRoot) verifyRoot()
        const target = containedReadPath(name, root)
        const parentSnapshot = readDirectorySnapshot(target, name, root)
        if (verifyRoot) verifyRoot()
        const initialTarget = fs.lstatSync(target)
        if (initialTarget.isSymbolicLink())
            throw invalidReadPath("path contains a symbolic link: " + name)
        if (initialTarget.isDirectory()) throw directoryReadError(name)
        if (!initialTarget.isFile()) throw invalidReadPath(name)
        const initialIdentity = {
            dev: initialTarget.dev,
            ino: initialTarget.ino,
        }

        if (invokeTestHook && secureReadBeforeOpenTestHook)
            secureReadBeforeOpenTestHook(name)

        if (verifyRoot) verifyRoot()
        let flags = fs.constants.O_RDONLY
        if (fs.constants.O_NOFOLLOW) flags |= fs.constants.O_NOFOLLOW

        let fd: number = null
        try {
            fd = fs.openSync(target, flags)
            const openedTarget = fs.fstatSync(fd)
            if (
                !openedTarget.isFile() ||
                !sameIdentity(openedTarget, initialIdentity)
            )
                throw invalidReadPath(name)

            verifyReadDirectorySnapshot(target, parentSnapshot, root)
            if (verifyRoot) verifyRoot()
            const currentTarget = fs.lstatSync(target)
            if (
                currentTarget.isSymbolicLink() ||
                !currentTarget.isFile() ||
                !sameIdentity(openedTarget, currentTarget)
            )
                throw invalidReadPath(name)
            verifyReadDirectorySnapshot(target, parentSnapshot, root)
            if (verifyRoot) verifyRoot()

            const value = await readFdAsync(fd)
            if (verifyRoot) verifyRoot()
            verifyReadDirectorySnapshot(target, parentSnapshot, root)
            return value
        } finally {
            if (fd !== null) await closeAsync(fd)
        }
    }

    async function secureSpecialReadFileAsync(
        root: string,
        name: string
    ): Promise<Buffer> {
        name = normalizeSpecialReadPath(name)
        const rootSnapshot = validatedBundledAssetRoot(root)
        if (bundledAssetRootAfterValidationTestHook)
            bundledAssetRootAfterValidationTestHook(rootSnapshot.root)
        return secureReadFileAsync(
            name,
            rootSnapshot.root,
            false,
            () => verifyBundledAssetRoot(rootSnapshot)
        )
    }

    async function firstSpecialReadAsync(
        roots: string[],
        name: string
    ): Promise<Buffer> {
        let lastError: any = null
        for (const root of roots) {
            try {
                return await secureSpecialReadFileAsync(root, name)
            } catch (error) {
                lastError = error
                if ((error as NodeJS.ErrnoException).code != "ENOENT")
                    throw error
            }
        }
        throw lastError || invalidReadPath(name)
    }

    function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
        return a.dev == b.dev && a.ino == b.ino
    }

    function safeDirectorySnapshot(
        name: string,
        create: boolean
    ): DirectorySnapshot {
        name = normalizeWritePath(name, true)
        let current = repoRoot
        const identities: FileIdentity[] = []
        const recordDirectory = (directory: string) => {
            const stat = fs.lstatSync(directory)
            if (stat.isSymbolicLink() || !stat.isDirectory())
                throw invalidWritePath(name)
            identities.push({ dev: stat.dev, ino: stat.ino })
        }

        recordDirectory(current)
        for (const part of name ? name.split("/") : []) {
            current = path.join(current, part)
            let stat: fs.Stats
            try {
                stat = fs.lstatSync(current)
            } catch (error) {
                if (
                    !create ||
                    (error as NodeJS.ErrnoException).code != "ENOENT"
                )
                    throw error
                try {
                    fs.mkdirSync(current)
                } catch (mkdirError) {
                    if ((mkdirError as NodeJS.ErrnoException).code != "EEXIST")
                        throw mkdirError
                }
                stat = fs.lstatSync(current)
            }
            if (stat.isSymbolicLink() || !stat.isDirectory())
                throw invalidWritePath(name)
            identities.push({ dev: stat.dev, ino: stat.ino })
        }

        const resolved = fs.realpathSync(current)
        if (resolved != repoRoot && !resolved.startsWith(repoRoot + path.sep))
            throw invalidWritePath(name)
        return { name, directory: current, identities }
    }

    function ensureSafeDirectory(name: string): string {
        return safeDirectorySnapshot(name, true).directory
    }

    function verifyDirectorySnapshot(expected: DirectorySnapshot) {
        const actual = safeDirectorySnapshot(expected.name, false)
        if (
            actual.identities.length != expected.identities.length ||
            actual.identities.some(
                (identity, index) =>
                    !sameIdentity(identity, expected.identities[index])
            )
        )
            throw invalidWritePath(expected.name)
    }

    // Node does not expose unlinkat(), so pathname cleanup cannot be made fully
    // atomic with the identity check. Only remove an entry while it still names
    // the inode created by this write; otherwise leave it alone rather than risk
    // deleting a file substituted by another process.
    function rollbackCreatedFile(target: string, identity: FileIdentity): boolean {
        try {
            const current = fs.lstatSync(target)
            if (
                current.isSymbolicLink() ||
                !current.isFile() ||
                !sameIdentity(current, identity)
            )
                return false
            fs.unlinkSync(target)
            return true
        } catch (error) {
            return (error as NodeJS.ErrnoException).code == "ENOENT"
        }
    }

    async function secureWriteFileAsync(
        name: string,
        val: Buffer,
        mode: WriteMode
    ): Promise<string> {
        name = normalizeWritePath(name)
        const spl = splitName(name)
        const parent = spl.parent == "/" ? "" : spl.parent
        let parentSnapshot: DirectorySnapshot
        try {
            parentSnapshot = safeDirectorySnapshot(parent, mode != "replace")
        } catch (error) {
            if (
                mode == "replace" &&
                (error as NodeJS.ErrnoException).code == "ENOENT"
            )
                throw replacementTargetNotFound(name)
            throw error
        }
        const target = containedPath(name)

        let exists = false
        let targetIdentity: FileIdentity = null
        try {
            const stat = fs.lstatSync(target)
            exists = true
            if (stat.isSymbolicLink() || !stat.isFile())
                throw invalidWritePath(name)
            targetIdentity = { dev: stat.dev, ino: stat.ino }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code != "ENOENT") throw error
        }
        if (mode == "replace" && !exists)
            throw replacementTargetNotFound(name)

        if (secureWriteBeforeOpenTestHook)
            secureWriteBeforeOpenTestHook(name)

        // Do not truncate until the descriptor and every parent directory have
        // also been revalidated after open. O_NOFOLLOW protects the final
        // component. If an external process wins the irreducible check/open
        // race, roll back a newly-created inode after checking its identity.
        let flags = fs.constants.O_WRONLY
        if (fs.constants.O_NOFOLLOW) flags |= fs.constants.O_NOFOLLOW
        if (mode == "create") flags |= fs.constants.O_CREAT | fs.constants.O_EXCL
        else if (mode == "upsert") {
            flags |= fs.constants.O_CREAT
            if (!exists) flags |= fs.constants.O_EXCL
        }

        const createdByOpen = !exists && (mode == "create" || mode == "upsert")
        let fd: number = null
        let openedIdentity: FileIdentity = null
        try {
            // Revalidate after the last pathname-dependent work and open
            // synchronously. This prevents in-process work from landing between
            // the check and O_CREAT; a swapped ancestor is rejected before it
            // can leave even an empty outside entry.
            verifyDirectorySnapshot(parentSnapshot)
            fd = fs.openSync(target, flags, 0o666)
            const stat = fs.fstatSync(fd)
            openedIdentity = { dev: stat.dev, ino: stat.ino }
            if (!stat.isFile()) throw invalidWritePath(name)

            verifyDirectorySnapshot(parentSnapshot)
            const currentTarget = fs.lstatSync(target)
            if (
                currentTarget.isSymbolicLink() ||
                !currentTarget.isFile() ||
                !sameIdentity(stat, currentTarget) ||
                (targetIdentity && !sameIdentity(stat, targetIdentity))
            )
                throw invalidWritePath(name)

            verifyDirectorySnapshot(parentSnapshot)
            await truncateFdAsync(fd, 0)
            await writeFdAsync(fd, val)
        } catch (error) {
            if (fd !== null) {
                fs.closeSync(fd)
                fd = null
            }
            if (
                createdByOpen &&
                openedIdentity &&
                !rollbackCreatedFile(target, openedIdentity)
            )
                winston.error(
                    `Could not safely roll back created repository file ${name}`
                )
            if (
                mode == "replace" &&
                (error as NodeJS.ErrnoException).code == "ENOENT"
            )
                throw replacementTargetNotFound(name)
            throw error
        } finally {
            if (fd !== null) await closeAsync(fd)
        }
        return name
    }

    let iface: GitFs = {
        pokeAsync,
        getFileAsync,
        getTextFileAsync,
        getTreeAsync,
        setTextFileAsync,
        setJsonFileAsync,
        setBinFileAsync,
        replaceBinFileAsync,
        createBinFileAsync,
        logAsync,
        onUpdate: f => onUpdate.push(f),
        path: repoPath,
        id: id,
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

    async function getTextFileAsync(
        name: string,
        ref = "master"
    ): Promise<string> {
        let buf = await getFileAsync(name, ref)
        return buf.toString("utf8")
    }

    function setTextFileAsync(
        name: string,
        val: string,
        msg: string,
        user: string
    ) {
        return setBinFileAsync(name, Buffer.from(val, "utf8"), msg, user)
    }

    function setJsonFileAsync(
        name: string,
        val: {},
        msg: string,
        user: string
    ) {
        return setBinFileAsync(
            name,
            Buffer.from(JSON.stringify(val, null, 4), "utf8"),
            msg,
            user
        )
    }

    function logAsync(path = ".") {
        return apiLockAsync("log", () =>
            runGitAsync([
                "log",
                "--name-status",
                "--pretty=fuller",
                "--max-count=200",
                path,
            ]).then(buf => parseLog(buf))
        )
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
        if (
            pushNeeded ||
            now - lastSyncTime > gitRefreshTimeoutSeconds * 1000
        ) {
            lastSyncTime = now
            syncRunning = true
            return apiLockAsync("commit", () =>
                pullAsync()
                    .then(() => {
                        if (pushNeeded) {
                            let v = pushNeeded
                            winston.info("pushing...")
                            return runGitAsync(["push", "--quiet"]).then(() => {
                                pushNeeded -= v
                                return getHeadRevAsync()
                            })
                        } else {
                            return Promise.resolve()
                        }
                    })
                    .then(
                        () => {
                            syncRunning = false
                        },
                        err => {
                            syncRunning = false
                            logs.logError(err)
                        }
                    )
            )
        }
        return Promise.resolve()
    }

    // export
    function createBinFileAsync(
        dir: string,
        basename: string,
        ext: string,
        buf: Buffer,
        msg: string,
        user: string
    ) {
        return apiLockAsync("commit", async () => {
            dir = normalizeWritePath(dir)
            if (
                !/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(basename) ||
                basename.length > 120 ||
                !/^\.(?:jpe?g|png)$/i.test(ext)
            )
                throw invalidWritePath(basename + ext)

            const fspath = ensureSafeDirectory(dir)
            const ents = fs.readdirSync(fspath)
            const requestedType = /^\.png$/i.test(ext) ? "png" : "jpeg"
            for (const bn of ents) {
                const existingType = /\.png$/i.test(bn)
                    ? "png"
                    : /\.jpe?g$/i.test(bn)
                    ? "jpeg"
                    : ""
                if (existingType != requestedType) continue

                const existing = path.join(fspath, bn)
                const stat = fs.lstatSync(existing)
                if (stat.isSymbolicLink() || !stat.isFile() || stat.size != buf.length)
                    continue

                let fd: number = null
                try {
                    let flags = fs.constants.O_RDONLY
                    if (fs.constants.O_NOFOLLOW) flags |= fs.constants.O_NOFOLLOW
                    fd = fs.openSync(existing, flags)
                    const oldBuffer = fs.readFileSync(fd)
                    if (oldBuffer.equals(buf)) return bn
                } finally {
                    if (fd !== null) fs.closeSync(fd)
                }
            }

            // Treat case variants as collisions on every platform so behavior is
            // stable on case-insensitive filesystems. O_EXCL remains the final
            // arbiter; retry if another writer (or the filesystem) reports one.
            const usedNames = new Set(ents.map(entry => entry.toLowerCase()))
            let no = 0
            while (true) {
                const fn = basename + (no ? "-" + no : "") + ext
                if (usedNames.has(fn.toLowerCase())) {
                    no++
                    continue
                }

                try {
                    await writeAndCommitAsync(
                        dir + "/" + fn,
                        buf,
                        msg,
                        user,
                        "create"
                    )
                    return fn
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code != "EEXIST")
                        throw error
                    usedNames.add(fn.toLowerCase())
                    no++
                }
            }
        })
    }

    // export
    function getFileAsync(name: string, ref = "master"): Promise<Buffer> {
        name = name.replace(/^\/+/, "")
        let m = /^gw\/(.*)/.exec(name)
        if (m)
            return firstSpecialReadAsync(
                [
                    "gw",
                    "built/gw",
                    "node_modules/gitwed/gw",
                    "node_modules/gitwed/built/gw",
                ],
                m[1]
            )

        m = /^gwcdn\/(.*)/.exec(name)
        if (m) return secureSpecialReadFileAsync(gwcdnDir, m[1])

        if (ref == "SHA") {
            let fn = tools.lookup(gwcdnBySHA, name)
            if (fn) {
                return secureSpecialReadFileAsync(gwcdnDir, fn)
            }
        }

        if (ref == "master") return secureReadFileAsync(name)
        return getGitObjectAsync(ref == "SHA" ? name : ref + ":" + name).then(
            obj => {
                if (obj.type == "blob") {
                    return obj.data
                } else {
                    throw new Error("not found")
                }
            }
        )
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
        if (justDir) return getHeadRevAsync()
        let id = rootId
        return Promise.resolve()
            .then(() =>
                runGitAsync([
                    "pull",
                    "--strategy=recursive",
                    "--strategy-option=ours",
                    "--no-edit",
                    "--quiet",
                ])
            )
            .then(getHeadRevAsync)
            .then(() => {
                if (id == rootId) winston.info(`empty pull at ${rootId}`)
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
                shell: false,
            })
            gitCatFile.stderr.setEncoding("utf8")
            gitCatFile.stderr.on("data", (msg: string) => {
                winston.error("[git cat-file error] " + msg)
            })
            gitCatFile.stdout.on("data", (buf: Buffer) =>
                gitCatFileBuf.push(buf)
            )
        }
    }

    function getGitObjectAsync(id: string) {
        if (!id || /[\r\n]/.test(id)) throw new Error("bad id: " + id)

        let cached = gitCache.get(id)
        if (cached) return Promise.resolve(cached)

        return apiLockAsync("cat-file", () => {
            // check again, maybe the object has been cached while we were waiting
            cached = gitCache.get(id)
            if (cached) return Promise.resolve(cached)

            winston.debug("cat: " + id)

            startGitCatFile()
            gitCatFile.stdin.write(id + "\n")
            let sizeLeft = 0
            let bufs: Buffer[] = []
            let res: GitObject = {
                id: id,
                type: "",
                memsize: 64,
                data: null,
            }
            let typeBuf: Buffer = null
            let loop = (): Promise<GitObject> =>
                gitCatFileBuf.shiftAsync().then(buf => {
                    startGitCatFile() // make sure the usage counter is updated
                    if (!res.type) {
                        winston.debug(
                            `cat-file ${id} -> ${buf.length} bytes; ${buf[0]} ${buf[1]}`
                        )
                        if (typeBuf) {
                            buf = Buffer.concat([typeBuf, buf])
                            typeBuf = null
                        } else {
                            while (buf[0] == 10) buf = buf.slice(1)
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
                            throw new Error(
                                "bad cat-file respose: " +
                                    buf.toString("utf8").slice(0, 100)
                            )
                        }
                        let lineS = line.toString("utf8")
                        if (/ missing/.test(lineS)) {
                            throw new Error("file missing")
                        }
                        let m = /^([0-9a-f]{40}) (\S+) (\d+)/.exec(lineS)
                        if (!m)
                            throw new Error(
                                "invalid cat-file response: " +
                                    lineS +
                                    " <nl> " +
                                    buf.toString("utf8")
                            )
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
                winston.debug(
                    `[cat-file] ${id} -> ${obj.id} ${obj.type} ${obj.data.length}`
                )
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
        if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error("bad ref: " + ref)
        if (path == "/")
            return getGitObjectAsync(ref).then(obj => {
                if (obj.type != "commit") throw new Error("bad type")
                return getGitObjectAsync(obj.commit.tree).then(o => o.tree)
            })

        let spl = splitName(path.replace(/\/$/, ""))
        return getTreeAsync(spl.parent, ref).then(ents => {
            if (!ents) return null
            let e = ents.find(x => x.name == spl.name)
            if (!e) return null
            return getGitObjectAsync(e.sha).then(o => o.tree)
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
                shell: false,
            })
            let outbufs: Buffer[] = []
            let errbufs: Buffer[] = []
            ch.stdin.end()
            ch.stderr.on("data", (buf: Buffer) => {
                errbufs.push(buf)
            })
            ch.stdout.on("data", (buf: Buffer) => {
                outbufs.push(buf)
            })
            ch.on("close", (code: number) => {
                if (errbufs.length)
                    winston.info(Buffer.concat(errbufs).toString("utf8").trim())
                if (code != 0) {
                    reject(new Error("Exit code: " + code + " from " + info))
                }
                resolve(Buffer.concat(outbufs).toString("utf8"))
            })
        })
    }

    // export
    function setBinFileAsync(
        name: string,
        val: Buffer,
        msg: string,
        useremail: string
    ) {
        return apiLockAsync("commit", () =>
            writeAndCommitAsync(name, val, msg, useremail, "upsert")
        )
    }

    // Image replacement must never silently create a new path.
    function replaceBinFileAsync(
        name: string,
        val: Buffer,
        msg: string,
        useremail: string
    ) {
        return apiLockAsync("commit", () =>
            writeAndCommitAsync(name, val, msg, useremail, "replace")
        )
    }

    async function writeAndCommitAsync(
        name: string,
        val: Buffer,
        msg: string,
        useremail: string,
        mode: WriteMode
    ) {
        name = normalizeWritePath(name)
        winston.info(
            `write file ${name} ${val.length} bytes; msg: ${msg}; author: ${useremail}`
        )
        await secureWriteFileAsync(name, val, mode)

        if (justDir) return

        const uname = useremail.replace(/@.*/, "")
        await runGitAsync(["--literal-pathspecs", "add", "--", name])
        await runGitAsync([
            "-c",
            "user.name=" + uname,
            "-c",
            "user.email=" + useremail,
            "commit",
            "-m",
            msg,
        ])
        await getHeadRevAsync()

        pushNeeded++
        // run in background
        maybeSyncAsync()
    }

    function statusCleanAsync() {
        if (justDir) return Promise.resolve()

        return runGitAsync(["status", "--porcelain", "--untracked-files"]).then(
            outp => {
                if (outp.trim()) {
                    winston.error(`git status output:\n${outp}`)
                    throw new Error("git not clean")
                }
            }
        )
    }
}

function readGWCDN() {
    const installed = "node_modules/gitwed/gwcdn/"
    const rootSnapshot = validatedBundledAssetRoot(
        fs.existsSync(installed) ? installed : "gwcdn/"
    )
    if (bundledAssetRootAfterValidationTestHook)
        bundledAssetRootAfterValidationTestHook(rootSnapshot.root)
    verifyBundledAssetRoot(rootSnapshot)
    const root = rootSnapshot.root
    const nextByName: SMap<string> = {}
    const nextBySHA: SMap<string> = {}
    const files = fs.readdirSync(root)
    verifyBundledAssetRoot(rootSnapshot)
    for (let fn of files) {
        let sha = githash(readBundledCdnFileSync(rootSnapshot, fn))
        nextByName[fn] = sha
        nextBySHA[sha] = fn
    }
    verifyBundledAssetRoot(rootSnapshot)
    gwcdnDir = root
    gwcdnByName = nextByName
    gwcdnBySHA = nextBySHA
}

function readBundledCdnFileSync(
    rootSnapshot: BundledAssetRootSnapshot,
    name: string
) {
    verifyBundledAssetRoot(rootSnapshot)
    const lexicalRoot = rootSnapshot.root
    const rootBefore = fs.lstatSync(lexicalRoot)
    const expectedRoot =
        rootSnapshot.identities[rootSnapshot.identities.length - 1]
    if (
        rootBefore.isSymbolicLink() ||
        !rootBefore.isDirectory() ||
        rootBefore.dev != expectedRoot.dev ||
        rootBefore.ino != expectedRoot.ino
    )
        throw new Error("Invalid bundled asset directory")

    const target = path.resolve(lexicalRoot, name)
    if (!target.startsWith(lexicalRoot + path.sep))
        throw new Error("Invalid bundled asset path")
    const before = fs.lstatSync(target)
    if (before.isSymbolicLink() || !before.isFile())
        throw new Error("Invalid bundled asset file")
    verifyBundledAssetRoot(rootSnapshot)

    let flags = fs.constants.O_RDONLY
    if (fs.constants.O_NOFOLLOW) flags |= fs.constants.O_NOFOLLOW
    let fd: number = null
    try {
        fd = fs.openSync(target, flags)
        const opened = fs.fstatSync(fd)
        verifyBundledAssetRoot(rootSnapshot)
        if (
            !opened.isFile() ||
            opened.dev != before.dev ||
            opened.ino != before.ino
        )
            throw new Error("Invalid bundled asset file")

        const value = fs.readFileSync(fd)
        verifyBundledAssetRoot(rootSnapshot)
        const after = fs.lstatSync(target)
        const rootAfter = fs.lstatSync(lexicalRoot)
        if (
            after.isSymbolicLink() ||
            !after.isFile() ||
            after.dev != opened.dev ||
            after.ino != opened.ino ||
            !rootAfter.isDirectory() ||
            rootAfter.dev != rootBefore.dev ||
            rootAfter.ino != rootBefore.ino
        )
            throw new Error("Invalid bundled asset file")
        return value
    } finally {
        if (fd !== null) fs.closeSync(fd)
    }
}

function validatedBundledAssetRoot(root: string): BundledAssetRootSnapshot {
    const absolute = path.resolve(root)
    const parsed = path.parse(absolute)
    let current = parsed.root
    const identities: BundledAssetRootIdentity[] = []
    const record = (candidate: string) => {
        const stat = fs.lstatSync(candidate)
        if (stat.isSymbolicLink() || !stat.isDirectory())
            throw new Error("Invalid bundled asset directory")
        identities.push({ path: candidate, dev: stat.dev, ino: stat.ino })
    }
    record(current)
    for (const part of path
        .relative(parsed.root, absolute)
        .split(path.sep)
        .filter(part => !!part)) {
        current = path.join(current, part)
        record(current)
    }
    return { root: absolute, identities }
}

function verifyBundledAssetRoot(snapshot: BundledAssetRootSnapshot) {
    for (const expected of snapshot.identities) {
        const stat = fs.lstatSync(expected.path)
        if (
            stat.isSymbolicLink() ||
            !stat.isDirectory() ||
            stat.dev != expected.dev ||
            stat.ino != expected.ino
        )
            throw new Error("Invalid bundled asset directory")
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
