import sharp = require("sharp")

export const maxImageSize = 2 * 1024 * 1024

export interface ImageRequestData {
    page: string
    full: string
    filename: string
    format?: string
}

export interface ValidatedImage {
    buffer: Buffer
    ext: ".jpg" | ".png"
}

function requestError(statusCode: number, message: string): Error {
    const error: any = new Error(message)
    error.statusCode = statusCode
    return error
}

function requestObject(value: unknown): any {
    if (!value || typeof value != "object" || Array.isArray(value))
        throw requestError(400, "Invalid image request")
    return value
}

export function uploadRequestData(value: unknown): ImageRequestData {
    const data = requestObject(value)
    if (
        typeof data.page != "string" ||
        typeof data.full != "string" ||
        typeof data.filename != "string" ||
        typeof data.format != "string"
    )
        throw requestError(400, "Invalid image request")
    return data as ImageRequestData
}

export function replacementRequestData(value: unknown): ImageRequestData {
    const data = requestObject(value)
    if (
        typeof data.full != "string" ||
        typeof data.filename != "string"
    )
        throw requestError(400, "Invalid image request")
    return data as ImageRequestData
}

function decodePath(value: unknown): { parts: string[]; trailingSlash: boolean } {
    if (typeof value != "string" || !value || /[\\\0\r\n]/.test(value))
        throw requestError(400, "Invalid image path")

    let decoded: string
    try {
        decoded = decodeURIComponent(value)
    } catch (e) {
        throw requestError(400, "Invalid image path encoding")
    }

    if (
        /[\\\0\r\n]/.test(decoded) ||
        decoded.startsWith("//") ||
        /^[a-zA-Z]:/.test(decoded)
    )
        throw requestError(400, "Invalid image path")

    const trailingSlash = decoded.endsWith("/")
    if (decoded[0] == "/") decoded = decoded.slice(1)
    if (trailingSlash) decoded = decoded.slice(0, -1)

    const parts = decoded ? decoded.split("/") : []
    if (
        parts.some(
            part =>
                !part ||
                part == "." ||
                part == ".." ||
                /[\x00-\x1f\x7f]/.test(part)
        )
    )
        throw requestError(400, "Invalid image path")

    return { parts, trailingSlash }
}

export function imageDirectoryForPage(page: unknown): string {
    const parsed = decodePath(page)
    if (parsed.parts.some(part => part[0] == "."))
        throw requestError(400, "Invalid image page")
    if (!parsed.trailingSlash) parsed.parts.pop()
    parsed.parts.push("img")
    return parsed.parts.join("/")
}

export function replacementImagePath(filename: unknown): string {
    const parsed = decodePath(filename)
    if (
        parsed.trailingSlash ||
        !parsed.parts.length ||
        parsed.parts.some(part => part[0] == ".")
    )
        throw requestError(400, "Invalid image filename")

    const result = parsed.parts.join("/")
    imageExtension(result)
    return result
}

export function imageBasename(filename: unknown): string {
    if (typeof filename != "string" || /[\0\r\n]/.test(filename))
        throw requestError(400, "Invalid image filename")

    let basename = filename
        .replace(/.*[\/\\]/, "")
        .toLowerCase()
        .replace(/\.[a-z]+$/, "")
        .replace(/[^\w\-]+/g, "_")

    if (!basename) basename = "image"
    if (basename[0] == "-") basename = "image_" + basename
    return basename.slice(0, 120)
}

function imageExtension(filename: string): ".jpg" | ".png" {
    const match = /\.([^.\/]+)$/.exec(filename)
    const ext = match && match[1].toLowerCase()
    if (ext == "jpg" || ext == "jpeg") return ".jpg"
    if (ext == "png") return ".png"
    throw requestError(415, "Only JPEG and PNG images are supported")
}

function claimedExtension(format: unknown): ".jpg" | ".png" {
    if (typeof format != "string")
        throw requestError(415, "Missing image format")
    const normalized = format.toLowerCase()
    if (normalized == "jpg" || normalized == "jpeg") return ".jpg"
    if (normalized == "png") return ".png"
    throw requestError(415, "Only JPEG and PNG images are supported")
}

function decodeBase64(value: unknown): Buffer {
    if (typeof value != "string" || !value || value.length % 4 != 0)
        throw requestError(400, "Invalid base64 image data")
    if (
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
            value
        )
    )
        throw requestError(400, "Invalid base64 image data")

    const buffer = Buffer.from(value, "base64")
    if (buffer.length > maxImageSize)
        throw requestError(413, "Image is too large")
    return buffer
}

function detectedExtension(buffer: Buffer): ".jpg" | ".png" | null {
    if (
        buffer.length >= 8 &&
        buffer.slice(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    )
        return ".png"
    if (
        buffer.length >= 3 &&
        buffer[0] == 0xff &&
        buffer[1] == 0xd8 &&
        buffer[2] == 0xff
    )
        return ".jpg"
    return null
}

export async function validateImageAsync(
    full: unknown,
    expected: unknown,
    expectedIsFilename = false
): Promise<ValidatedImage> {
    const buffer = decodeBase64(full)
    const expectedExt = expectedIsFilename
        ? imageExtension(expected as string)
        : claimedExtension(expected)
    const detectedExt = detectedExtension(buffer)
    if (!detectedExt)
        throw requestError(415, "Only JPEG and PNG images are supported")
    if (detectedExt != expectedExt)
        throw requestError(415, "Image content does not match its extension")

    let format: string
    try {
        const metadata = await sharp(buffer).metadata()
        format = metadata.format
        if (!metadata.width || !metadata.height)
            throw new Error("Image has no dimensions")
    } catch (e) {
        throw requestError(415, "Invalid image data")
    }

    const actualExt =
        format == "jpeg" ? ".jpg" : format == "png" ? ".png" : null
    if (!actualExt)
        throw requestError(415, "Only JPEG and PNG images are supported")
    if (actualExt != expectedExt)
        throw requestError(415, "Image content does not match its extension")

    return { buffer, ext: actualExt }
}
