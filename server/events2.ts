import express = require("express")
import path = require("path")
import fs = require("fs")
import gitfs = require("./gitfs")
import gmaps = require("./gmaps")
import tools = require("./tools")
import expander = require("./expander")
import bluebird = require("bluebird")
import winston = require("winston")

const fsPath = "v2/"

// https://schema.org/PostalAddress
export interface Geo {
    latitude?: number
    longitude?: number
}
export interface PostalAddress extends Geo {
    addressLocality: string // city
    streetAddress?: string
    addressCountry?: string
    postalCode?: string
}

export interface Event {
    eventId: number
    name: string
    descriptions: string
    startDate: string
    endDate: string
    organizer: string // center
}

export interface Translation {
    lang: string
}

export interface WithTranslations {
    lang?: string
    translations?: Translation[]
}

export interface EventTranslation extends Translation {
    name?: string
    description?: string
    speakerBio?: string
}

export interface EventIndexEntry extends Translation {
    eventId: number
    startDate: string // "2016-01-05"
    endDate: string
    name: string
    organizer: string // "wroclaw"
    location: PostalAddress
    translations?: EventTranslation[]
}

export interface EventListEntry extends EventIndexEntry {
    weekdayRange?: string
    dateRange?: string
    combinedRange?: string
}

// https://schema.org/Event
export interface FullEvent extends EventListEntry {
    startTime?: string // "20:00"
    description: string
    speakerBio?: string
    location: PostalAddress
}

export interface FullEventWithUser extends FullEvent {
    editorEmail: string
}

export interface EventIndex {
    events: EventIndexEntry[]
    nextId: number
}

let index: EventIndex
let currEventsPath = ""
let eventsCache: SMap<string> = {}

export function getLangs(ev: WithTranslations) {
    let langs = [ev.lang || "en"]
    if (ev.translations) {
        for (let t of ev.translations) {
            if (t.lang && langs.indexOf(t.lang) < 0) langs.push(t.lang)
        }
    }
    return langs
}

function forIndex(js: FullEvent): EventIndexEntry {
    return {
        eventId: js.eventId,
        startDate: js.startDate,
        endDate: js.endDate,
        name: js.name,
        organizer: js.organizer,
        lang: js.lang,
        location: {
            addressLocality: js.location.addressLocality,
            addressCountry: js.location.addressCountry,
        },
        translations: (js.translations || []).map(t => ({
            lang: t.lang,
            title: t.name,
        })),
    }
}

function eventFn(id: number) {
    return ("000000" + id).slice(-6) + ".json"
}

async function saveEventAsync(e: FullEvent, user: string) {
    eventsCache[e.eventId + ""] = JSON.stringify(e)

    let idx = index.events.findIndex(x => x.eventId == e.eventId)
    if (idx < 0) idx = index.events.length
    index.events.splice(idx, 1, forIndex(e))
    fs.writeFileSync(
        path.join(currEventsPath, "index.json"),
        JSON.stringify(index, null, 1)
    )

    await gitfs.events.setJsonFileAsync(
        fsPath + eventFn(e.eventId),
        e,
        "Update " + e.name,
        user
    )
}

export async function readEventAsync(id: number): Promise<FullEvent> {
    if (!gitfs.events) {
        return {
            eventId: 8,
            organizer: "notown",
            startDate: "2017-09-28",
            endDate: "",
            name: "Ngondro in Daily Life by Foo Bar",
            description:
                "<p>Start start start! something something!\n</p>\n<p>Second para 2</p>",
            startTime: "20:00",
            lang: "en",
            location: {
                addressLocality: "Notown",
            },
        }
    }

    if (!index.events.some(e => e.eventId == id)) return null
    let curr = eventsCache[id + ""]
    let r: FullEvent
    if (curr) {
        r = JSON.parse(curr)
    } else {
        let text = await gitfs.events.getTextFileAsync(fsPath + eventFn(id))
        r = JSON.parse(text)
        curr = eventsCache[id + ""] = JSON.stringify(r)
    }
    return r
}

function loadOrCreateIndex() {
    let idx = path.join(currEventsPath, "index.json")
    if (fs.existsSync(idx)) {
        index = readJson("index.json")
        try {
            // this file should not exists if the index is correct
            readJson(eventFn(index.nextId))
        } catch {
            // if we fail to read the nextId file, it means it doesn't exists
            // and the index looks all right, just return
            return
        }
    }

    winston.info("creating events index...")
    index = {
        events: [],
        nextId: 0,
    }
    for (let fn of fs.readdirSync(currEventsPath)) {
        if (/^\d+\.json$/.test(fn)) {
            let js: FullEvent = readJson(fn)
            index.nextId = Math.max(index.nextId, js.eventId || 0)
            index.events.push(forIndex(js))
        }
    }
    index.nextId++
    fs.writeFileSync(idx, JSON.stringify(index, null, 1))

    function readJson(fn: string) {
        return JSON.parse(
            fs.readFileSync(path.join(currEventsPath, fn), "utf8")
        )
    }
}

function formatDate(d: Date) {
    return d.toISOString().slice(0, 10)
}

function validDate(d: string) {
    return d == null || d == "" || /^2\d\d\d-\d\d-\d\d$/.test(d)
}

function validTime(d: string) {
    return d == null || d == "" || /^\d\d:\d\d$/.test(d)
}

// see https://en.wikipedia.org/wiki/ISO_3166-1#Officially_assigned_code_elements
// should be two-letter code like PL or US
function validCountry(c: string) {
    return /^[A-Z][A-Z]$/.test(c)
}

function validCity(c: string) {
    return typeof c == "string" && c.length >= 2 && c.length < 100
}

function applyTranslation(r: EventListEntry, lang: string) {
    r = tools.clone(r)
    if (!lang) return r

    for (let t of r.translations || []) {
        if (t.lang == lang) tools.copyFields(r, t)
    }
    delete r.translations
    augmentEvent(r, lang)
    return r
}

function augmentEvent(r: EventListEntry, lang: string) {
    r.weekdayRange = tools.weekDay(r.startDate, lang)
    r.dateRange = tools.monthPlusDay(r.startDate, lang)
    r.combinedRange = tools.fullDate(r.startDate, lang)
    if (r.endDate && r.endDate != r.startDate) {
        r.weekdayRange += " - " + tools.weekDay(r.endDate, lang)
        if (
            tools.monthName(r.startDate, lang) !=
            tools.monthName(r.endDate, lang)
        ) {
            r.dateRange += " - " + tools.monthPlusDay(r.endDate, lang)
        } else {
            r.dateRange += " - " + tools.monthDay(r.endDate, lang)
        }
        r.combinedRange += tools.fullDate(r.endDate, lang)
    }
}

export async function queryEventsAsync(query: SMap<string>, lang: string) {
    let loc = tools.getLocale(lang)
    if (!gitfs.events) {
        return {
            totalCount: 0,
            events: [],
        }
    }

    let startDate =
        query["start"] || formatDate(new Date(Date.now() - 23 * 3600 * 1000))
    let stopDate = query["stop"] || "9999-99-99"
    let organizer = query["organizer"] || "*"
    let country = query["country"] || "*"

    country = country.toUpperCase()

    let events = index.events.filter(e => {
        let end = e.endDate || e.startDate
        if (end < startDate) return false
        if (e.startDate > stopDate) return false
        if (organizer != "*" && e.organizer != organizer) return false
        return true
    })

    if (country != "*") {
        events = events.filter(e => {
            if (e.location.addressCountry !== country) return false
            return true
        })
    }

    events.sort(
        (a, b) =>
            tools.strcmp(a.startDate, b.startDate) || a.eventId - b.eventId
    )
    let totalCount = events.length
    let skip = parseInt(query["skip"]) || 0
    if (skip) events = events.slice(skip)
    let count = Math.abs(parseInt(query["count"]) || 100)
    if (count > 100) count = 100
    if (events.length > count) events = events.slice(0, count)
    return {
        totalCount,
        events: events.map(e => applyTranslation(e, lang)),
    }
}

async function setMapImgAsync(
    pref: string,
    addrObj: PostalAddress,
    cfg: expander.ExpansionConfig
) {
    let addr = gmaps.cleanAddress(
        addrObj.streetAddress +
            ", " +
            addrObj.addressLocality +
            " " +
            addrObj.postalCode
    )
    if (!cfg.vars) cfg.vars = {}
    cfg.vars[pref + "mapurl"] = "https://maps.google.com/?q=" + encodeURI(addr)
    cfg.vars[pref + "mapimg"] = await gmaps.getMapsPictureAsync({
        address: addr,
    })
}

function validateEvent(ev: FullEvent) {
    if (!ev.startDate || !validDate(ev.startDate)) return "invalid startDate"
    if (!validDate(ev.endDate)) return "invalid endDate"
    if (!validTime(ev.startTime)) return "invalid startTime"
    if (!ev.location) return "location missing"
    if (!validCountry(ev.location.addressCountry))
        return "invalid location.addressCountry"
    if (!validCity(ev.location.addressLocality))
        return "invalid location.addressLocality"
    if (ev.translations != null) {
        if (!Array.isArray(ev.translations)) return "invalid translations"
        if (!ev.translations.every(t => tools.validateLang(t.lang)))
            return "some translations have invalid 'lang' property"
    }
    if (!ev.endDate) ev.endDate = ev.startDate
    return null
}

export async function addVarsAsync(cfg: expander.ExpansionConfig) {
    if (cfg.eventInfo) {
        const ei = cfg.eventInfo as FullEvent
        augmentEvent(ei, cfg.lang)

        if (!cfg.contentOverride) cfg.contentOverride = {}

        let base = tools.jsonFlatten(ei)
        for (let k of Object.keys(base)) {
            let v = base[k]
            cfg.contentOverride["ev_" + k] = v + ""
        }

        await setMapImgAsync("ev_", ei.location, cfg)
    }
}

export function initRoutes(app: express.Express) {
    if (!gitfs.events) return
    currEventsPath = path.join(gitfs.config.eventsRepoPath, fsPath)
    loadOrCreateIndex()

    winston.debug("mounting events v2")

    app.get("/api/v2/events/:id", async (req, res, next) => {
        let id = parseInt(req.params["id"])
        let ev = await readEventAsync(id)
        if (!ev) {
            res.status(404).json({})
            return
        }
        res.json(applyTranslation(ev, tools.getQuery(req, "lang")))
    })

    app.get("/api/v2/events", async (req, res, next) => {
        res.json(
            await queryEventsAsync(
                tools.convertQuery(req.query),
                tools.getQuery(req, "lang")
            )
        )
    })

    app.post("/api/v2/events", async (req, res, next) => {
        if (!gitfs.config.eventSecret) return res.status(444).end()

        if (
            req.header("x-gitwed-secret") !== gitfs.config.eventSecret &&
            req.query["access_token"] !== gitfs.config.eventSecret
        )
            return res.status(403).end()

        let bodies: FullEventWithUser[] = req.body
        if (!Array.isArray(req.body)) bodies = [req.body]

        for (let ev of bodies) {
            const err = validateEvent(ev)
            if (err) {
                res.status(412).json({ message: err })
                return
            }
            if (ev.eventId && !(await readEventAsync(ev.eventId))) {
                res.status(404).json({
                    message: `Event ${ev.eventId} doesn't exists yet`,
                })
                return
            }
        }

        for (let ev of bodies) {
            if (!ev.eventId) ev.eventId = index.nextId++
        }

        for (let ev of bodies) {
            if (!ev.eventId) ev.eventId = index.nextId++
        }

        let numUpdated = 0
        for (let ev of bodies) {
            const user = ev.editorEmail || "API@dwbe.org"
            delete ev.editorEmail
            if (eventsCache[ev.eventId + ""] != JSON.stringify(ev)) {
                await saveEventAsync(ev, user)
                numUpdated++
            }
        }

        res.json({ updated: numUpdated })
    })
}
