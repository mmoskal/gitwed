import fs = require("fs")

export function existsAsync(name:string) {
    return Promise.resolve(fs.existsSync("html/" + name))    
}

let readAsync = Promise.promisify(fs.readFile)
let writeAsync:any = Promise.promisify(fs.writeFile)

export function getAsync(name:string) {
    return readAsync("html/" + name).then(b => b.toString("utf8"))
}

export function setAsync(name:string,val:string) {
    return writeAsync("html/" + name, val)
}