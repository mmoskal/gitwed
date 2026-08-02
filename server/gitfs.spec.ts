import fs = require("fs")
import os = require("os")
import path = require("path")
import childProcess = require("child_process")
import * as gitfs from "./gitfs"

describe("GitFs repository access", () => {
    let tempDir: string
    let repoDir: string
    let outsideDir: string
    let repo: gitfs.GitFs

    beforeAll(async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitwed-gitfs-"))
        repoDir = path.join(tempDir, "repo")
        outsideDir = path.join(tempDir, "outside")
        fs.mkdirSync(repoDir)
        fs.mkdirSync(outsideDir)
        fs.writeFileSync(path.join(repoDir, ".initial"), "initial")
        childProcess.execFileSync("git", ["init", "--quiet"], { cwd: repoDir })
        childProcess.execFileSync("git", ["add", ".initial"], { cwd: repoDir })
        childProcess.execFileSync(
            "git",
            [
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "--quiet",
                "-m",
                "initial",
            ],
            { cwd: repoDir }
        )

        await gitfs.initAsync({
            repoPath: repoDir,
            justDir: true,
        } as gitfs.Config)
        repo = gitfs.main
    })

    afterAll(() => {
        fs.rmSync(tempDir, { recursive: true, force: true })
    })

    it("creates a unique file safely and deduplicates matching image data", async () => {
        const value = Buffer.from("image bytes")
        const first = await repo.createBinFileAsync(
            "site/img",
            "photo",
            ".png",
            value,
            "image",
            "test@example.com"
        )
        const second = await repo.createBinFileAsync(
            "site/img",
            "another",
            ".png",
            value,
            "image",
            "test@example.com"
        )

        expect(first).toBe("photo.png")
        expect(second).toBe("photo.png")
        expect(fs.readFileSync(path.join(repoDir, "site/img/photo.png"))).toEqual(
            value
        )
    })

    it("uses a suffix for case-variant filename collisions", async () => {
        const imageDir = path.join(repoDir, "site/img")
        fs.writeFileSync(path.join(imageDir, "Cover.PNG"), "existing")

        const filename = await repo.createBinFileAsync(
            "site/img",
            "cover",
            ".png",
            Buffer.from("different"),
            "image",
            "test@example.com"
        )

        expect(filename).toBe("cover-1.png")
        expect(fs.readFileSync(path.join(imageDir, "Cover.PNG"), "utf8")).toBe(
            "existing"
        )
        expect(fs.readFileSync(path.join(imageDir, filename), "utf8")).toBe(
            "different"
        )
    })

    it("rejects traversal and option-like creation inputs", async () => {
        await expect(
            repo.createBinFileAsync(
                "../outside",
                "photo",
                ".png",
                Buffer.from("x"),
                "image",
                "test@example.com"
            )
        ).rejects.toThrow("Invalid repository write path")
        await expect(
            repo.createBinFileAsync(
                "site/img",
                "-delete",
                ".png",
                Buffer.from("x"),
                "image",
                "test@example.com"
            )
        ).rejects.toThrow("Invalid repository write path")
    })

    it("requires replacement targets to be existing regular files", async () => {
        const missing = repo.replaceBinFileAsync(
            "site/img/missing.png",
            Buffer.from("new"),
            "replace",
            "test@example.com"
        )
        await expect(missing).rejects.toMatchObject({ statusCode: 404 })
        await expect(
            repo.replaceBinFileAsync(
                "missing-parent/missing.png",
                Buffer.from("new"),
                "replace",
                "test@example.com"
            )
        ).rejects.toMatchObject({ statusCode: 404 })
        expect(fs.existsSync(path.join(repoDir, "missing-parent"))).toBe(false)

        await repo.replaceBinFileAsync(
            "/site/img/photo.png",
            Buffer.from("new"),
            "replace",
            "test@example.com"
        )
        expect(fs.readFileSync(path.join(repoDir, "site/img/photo.png"), "utf8")).toBe(
            "new"
        )
    })

    it("contains working-tree reads and rejects symbolic-link components", async () => {
        const secret = path.join(outsideDir, "secret.txt")
        const linkedDirectory = path.join(repoDir, "read-link")
        const linkedFile = path.join(repoDir, "linked-secret.txt")
        fs.writeFileSync(secret, "secret")
        fs.symlinkSync(outsideDir, linkedDirectory, "dir")
        fs.symlinkSync(secret, linkedFile, "file")

        await expect(
            repo.getFileAsync("../outside/secret.txt")
        ).rejects.toThrow("Invalid repository read path")
        await expect(
            repo.getFileAsync("read-link/secret.txt")
        ).rejects.toThrow("symbolic link")
        await expect(repo.getFileAsync("linked-secret.txt")).rejects.toThrow(
            "symbolic link"
        )
    })

    it("preserves EISDIR for root and nested working-tree directory reads", async () => {
        fs.mkdirSync(path.join(repoDir, "read-directory"))

        await expect(repo.getFileAsync("/")).rejects.toMatchObject({
            code: "EISDIR",
        })
        await expect(repo.getFileAsync("read-directory")).rejects.toMatchObject({
            code: "EISDIR",
        })
    })

    it("continues to read files from Git refs and object IDs", async () => {
        await expect(repo.getFileAsync(".initial", "HEAD")).resolves.toEqual(
            Buffer.from("initial")
        )
        await expect(
            repo.getFileAsync(gitfs.githash(Buffer.from("initial")), "SHA")
        ).resolves.toEqual(Buffer.from("initial"))
    })

    it("does not return outside bytes when a read ancestor is swapped", async () => {
        const originalDir = path.join(repoDir, "site/read-race")
        const parkedDir = path.join(repoDir, "site/read-race-parked")
        const outsideFile = path.join(outsideDir, "read-race.txt")
        fs.mkdirSync(originalDir)
        fs.writeFileSync(path.join(originalDir, "read-race.txt"), "inside")
        fs.writeFileSync(outsideFile, "outside")

        gitfs.setSecureReadBeforeOpenTestHook(name => {
            if (name != "site/read-race/read-race.txt") return
            fs.renameSync(originalDir, parkedDir)
            fs.symlinkSync(outsideDir, originalDir, "dir")
        })

        try {
            await expect(
                repo.getFileAsync("site/read-race/read-race.txt")
            ).rejects.toThrow("Invalid repository read path")
            expect(fs.readFileSync(outsideFile, "utf8")).toBe("outside")
            expect(
                fs.readFileSync(path.join(parkedDir, "read-race.txt"), "utf8")
            ).toBe("inside")
        } finally {
            gitfs.setSecureReadBeforeOpenTestHook(null)
            if (
                fs.existsSync(originalDir) &&
                fs.lstatSync(originalDir).isSymbolicLink()
            )
                fs.unlinkSync(originalDir)
            if (fs.existsSync(parkedDir)) fs.renameSync(parkedDir, originalDir)
        }
    })

    it("does not follow symlinked parents or replacement files", async () => {
        const external = path.join(outsideDir, "external.png")
        fs.writeFileSync(external, "outside")
        fs.symlinkSync(outsideDir, path.join(repoDir, "site/escape"), "dir")
        fs.symlinkSync(external, path.join(repoDir, "site/img/link.png"), "file")

        await expect(
            repo.createBinFileAsync(
                "site/escape",
                "new",
                ".png",
                Buffer.from("attack"),
                "image",
                "test@example.com"
            )
        ).rejects.toThrow("Invalid repository write path")
        await expect(
            repo.replaceBinFileAsync(
                "site/img/link.png",
                Buffer.from("attack"),
                "replace",
                "test@example.com"
            )
        ).rejects.toThrow("Invalid repository write path")
        expect(fs.readFileSync(external, "utf8")).toBe("outside")
        expect(fs.existsSync(path.join(outsideDir, "new.png"))).toBe(false)
    })

    it("does not write through an ancestor swapped after validation", async () => {
        const originalDir = path.join(repoDir, "site/race")
        const parkedDir = path.join(repoDir, "site/race-parked")
        const outsideFile = path.join(outsideDir, "race.png")
        fs.mkdirSync(originalDir)
        fs.writeFileSync(path.join(originalDir, "race.png"), "inside")
        fs.writeFileSync(outsideFile, "outside")

        gitfs.setSecureWriteBeforeOpenTestHook(name => {
            if (name != "site/race/race.png") return
            fs.renameSync(originalDir, parkedDir)
            fs.symlinkSync(outsideDir, originalDir, "dir")
        })

        try {
            await expect(
                repo.replaceBinFileAsync(
                    "site/race/race.png",
                    Buffer.from("attack"),
                    "replace",
                    "test@example.com"
                )
            ).rejects.toThrow("Invalid repository write path")
            expect(fs.readFileSync(outsideFile, "utf8")).toBe("outside")
            expect(
                fs.readFileSync(path.join(parkedDir, "race.png"), "utf8")
            ).toBe("inside")
        } finally {
            gitfs.setSecureWriteBeforeOpenTestHook(null)
            if (fs.lstatSync(originalDir).isSymbolicLink()) fs.unlinkSync(originalDir)
            fs.renameSync(parkedDir, originalDir)
        }
    })

    it("maps a replacement parent disappearing before open to 404", async () => {
        const originalDir = path.join(repoDir, "site/missing-race")
        const parkedDir = path.join(repoDir, "site/missing-race-parked")
        const target = path.join(originalDir, "image.png")
        fs.mkdirSync(originalDir)
        fs.writeFileSync(target, "inside")

        gitfs.setSecureWriteBeforeOpenTestHook(name => {
            if (name != "site/missing-race/image.png") return
            fs.renameSync(originalDir, parkedDir)
        })

        try {
            await expect(
                repo.replaceBinFileAsync(
                    "site/missing-race/image.png",
                    Buffer.from("replacement"),
                    "replace",
                    "test@example.com"
                )
            ).rejects.toMatchObject({ statusCode: 404 })
            expect(
                fs.readFileSync(path.join(parkedDir, "image.png"), "utf8")
            ).toBe("inside")
        } finally {
            gitfs.setSecureWriteBeforeOpenTestHook(null)
            if (fs.existsSync(parkedDir)) fs.renameSync(parkedDir, originalDir)
        }
    })

    it("does not leave an outside entry when a create ancestor is swapped", async () => {
        const originalDir = path.join(repoDir, "site/create-race")
        const parkedDir = path.join(repoDir, "site/create-race-parked")
        const outsideFile = path.join(outsideDir, "created.png")
        fs.mkdirSync(originalDir)

        gitfs.setSecureWriteBeforeOpenTestHook(name => {
            if (name != "site/create-race/created.png") return
            fs.renameSync(originalDir, parkedDir)
            fs.symlinkSync(outsideDir, originalDir, "dir")
        })

        try {
            await expect(
                repo.createBinFileAsync(
                    "site/create-race",
                    "created",
                    ".png",
                    Buffer.from("attack"),
                    "image",
                    "test@example.com"
                )
            ).rejects.toThrow("Invalid repository write path")
            expect(fs.existsSync(outsideFile)).toBe(false)
        } finally {
            gitfs.setSecureWriteBeforeOpenTestHook(null)
            if (fs.lstatSync(originalDir).isSymbolicLink()) fs.unlinkSync(originalDir)
            fs.renameSync(parkedDir, originalDir)
        }
    })

    it("commits a leading-colon filename with literal Git pathspecs", async () => {
        const realRepoDir = path.join(tempDir, "real-repo")
        const remoteDir = path.join(tempDir, "remote.git")
        fs.mkdirSync(realRepoDir)
        childProcess.execFileSync("git", ["init", "--bare", "--quiet", remoteDir])
        childProcess.execFileSync("git", ["init", "--quiet", "-b", "master"], {
            cwd: realRepoDir,
        })
        fs.writeFileSync(path.join(realRepoDir, ".initial"), "initial")
        childProcess.execFileSync("git", ["add", ".initial"], {
            cwd: realRepoDir,
        })
        childProcess.execFileSync(
            "git",
            [
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "--quiet",
                "-m",
                "initial",
            ],
            { cwd: realRepoDir }
        )
        childProcess.execFileSync("git", ["remote", "add", "origin", remoteDir], {
            cwd: realRepoDir,
        })
        childProcess.execFileSync(
            "git",
            ["push", "--quiet", "--set-upstream", "origin", "master"],
            { cwd: realRepoDir }
        )

        await gitfs.initAsync({
            repoPath: realRepoDir,
            production: true,
        } as gitfs.Config)
        const filename = ":(literal)colon.png"
        await gitfs.main.setBinFileAsync(
            filename,
            Buffer.from("literal path"),
            "literal path",
            "test@example.com"
        )

        const names = childProcess
            .execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", "HEAD"], {
                cwd: realRepoDir,
            })
            .toString("utf8")
            .split("\0")
        expect(names).toContain(filename)

        // writeAndCommitAsync deliberately schedules remote synchronization in
        // the background. Wait for that existing behavior before temp cleanup.
        for (let tries = 0; tries < 100; tries++) {
            const remoteNames = childProcess
                .execFileSync(
                    "git",
                    [
                        "--git-dir",
                        remoteDir,
                        "ls-tree",
                        "-r",
                        "--name-only",
                        "-z",
                        "master",
                    ]
                )
                .toString("utf8")
                .split("\0")
            if (remoteNames.indexOf(filename) >= 0) break
            if (tries == 99) throw new Error("background Git push did not finish")
            await new Promise(resolve => setTimeout(resolve, 10))
        }
        await new Promise(resolve => setTimeout(resolve, 20))
    })
})
