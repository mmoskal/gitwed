import fs = require("fs")
import path = require("path")
import querystring = require("querystring")
import crypto = require("crypto")
import tools = require("./tools")
import logs = require("./logs")
import gitfs = require("./gitfs")
import winston = require('winston');

export interface MapOptions {
    address: string;
    zoom?: number;
    scale?: number;
    size?: string;
    maptype?: string;
    language?: string;
    markers?: string;
}

export function cleanAddress(addr: string) {
    return addr.replace(/<br>/ig, ", ")
}

export async function getMapsPictureAsync(opts: MapOptions) {
    if (!opts.zoom) opts.zoom = 16
    if (!opts.scale) opts.scale = 2
    if (!opts.size) opts.size = "280x200"
    opts.markers = "color:red|" + cleanAddress(opts.address)
    delete opts.address
    let qs = querystring.stringify(opts)
    let hash = tools.sha256(qs)
    let fn = "map-cache/" + hash + ".png"
    if (!fs.existsSync(fn)) {
        let res = await tools.requestAsync({
            url: "https://maps.googleapis.com/maps/api/staticmap?" + qs + "&key=" + gitfs.config.gmapsKey
        })
        tools.mkdirP("map-cache")
        if (res.statusCode == 200) {
            fs.writeFileSync(fn, res.buffer)
        } else {
            winston.error("bad response from google maps: " + res.statusCode + " / " + res.text, opts)
        }
    }
    return (gitfs.config.cdnPath || "") + "/map-cache/" + hash + ".png"
}

interface GMapsComponent {
    long_name: string;
    short_name: string;
    types: string[];
}
interface GMapsResult {
    address_components: GMapsComponent[];
    formatted_address: string;
    geometry: {
        location: {
            lat: number;
            lng: number;
        }
        location_type: string;
    };
    place_id: string;
    types: string[];
}
interface GMapsResults {
    results: GMapsResult[];
    status: string;
}

export interface ParsedAddress {
    street: string;
    street_number: string;
    city: string;
    country: string;
    state: string;
    fullcity: string;
}

const addrCache: SMap<ParsedAddress> = {}
const emptyAddr: ParsedAddress = {
    street: "",
    street_number: "",
    city: "",
    country: "",
    state: "",
    fullcity: "?"
}

export async function parseAddressAsync(addr: string): Promise<ParsedAddress> {
    addr = cleanAddress(addr)
    let res = tools.lookup(addrCache, addr)
    if (res) return res
    let hash = tools.sha256(addr)
    let fn = "map-cache/" + hash + "-addr.json"
    let cached = await tools.readTextFileAsync(fn)
    if (!cached) {
        let res = await tools.requestAsync({
            url: "https://maps.googleapis.com/maps/api/geocode/json?address=" +
            encodeURIComponent(addr) + "&key=" + gitfs.config.gmapsKey
        })
        tools.mkdirP("map-cache")
        if (res.statusCode == 200) {
            cached = res.text
            fs.writeFileSync(fn, res.text)
        } else {
            winston.error("bad response from google maps (geolocation): " + res.statusCode + " / " + res.text, addr)
        }
    }

    let gmdata = JSON.parse(cached || "{}") as GMapsResults
    if (!gmdata.results || gmdata.results.length == 0)
        return tools.clone(emptyAddr)
    let fnd = (tp: string) =>
        gmdata.results[0].address_components.find(c => c.types.indexOf(tp) >= 0)
    let long = (tp: string) => {
        let v = fnd(tp)
        if (v) return v.long_name
        else return ""
    }
    let short = (tp: string) => {
        let v = fnd(tp)
        if (v) return v.short_name
        else return ""
    }
    res = {
        street: short("route"),
        street_number: short("street_number"),
        city: short("postal_town") || short("locality"),
        country: short("country"),
        state: "",
        fullcity: ""
    }
    if (res.country == "US" || res.country == "CA")
        res.state = short("administrative_area_level_1")
    res.fullcity = res.city + (res.state ? ", " + res.state : "") + ", " + res.country
    return res
}