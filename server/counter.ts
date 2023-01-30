import fs = require("fs")

export interface CountPost {
    path: string
    count: number
    from?: string
    comment?: string
    password?: string
}

export interface CountEntry {
    now: number
    count: number
    from?: string
    comment?: string
}

const numRecentEntries = 20

export interface CachedCount {
    recentEntries: CountEntry[]
    count: number
}

function cntFile(id: string) {
    return "counters/" + id + ".json"
}

const counts: SMap<CachedCount> = {}

export function getCount(id: string) {
    if (!counts[id]?.recentEntries) {
        counts[id] = {
            recentEntries: [],
            count: 0,
        }
        const c = counts[id]
        let str = ""
        try {
            str = fs.readFileSync(cntFile(id), "utf-8")
        } catch {}
        const entries = str
            .split(/\n/)
            .map(l => l.trim())
            .filter(l => !!l)
            .map<CountEntry>(l => JSON.parse(l))
        entries.forEach(e => {
            c.count += e.count
        })
        c.recentEntries = entries.slice(-numRecentEntries)
    }
    return counts[id]
}

export function addCount(cntid: string, entry: CountEntry) {
    const ee = getCount(cntid)
    ee.count += entry.count
    ee.recentEntries.push(entry)
    if (ee.recentEntries.length > numRecentEntries) ee.recentEntries.shift()
    fs.appendFileSync(cntFile(cntid), JSON.stringify(entry) + "\n")
    return ee
}
