import fs = require("fs")

export function existsAsync(name:string) {
    return Promise.resolve(fs.existsSync("html/" + name))    
}

let readAsync = Promise.promisify(fs.readFile)

export function getAsync(name:string) {
    return readAsync("html/" + name).then(b => b.toString("utf8"))

}