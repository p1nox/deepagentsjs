import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";
import { FilesystemBackend } from "./filesystem.js";

/**
 * Helper to write a file with automatic parent directory creation
 */
async function writeFile(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

/**
 * Helper to create a unique temporary directory for each test
 */
function createTempDir(): string {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), "deepagents-test-"));
}

/**
 * Helper to recursively remove a directory
 */
async function removeDir(dirPath: string) {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch {
    // Ignore errors during cleanup
  }
}

describe("FilesystemBackend", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(async () => {
    await removeDir(tmpDir);
  });

  it("should work in normal mode with absolute paths", async () => {
    const root = tmpDir;
    const f1 = path.join(root, "a.txt");
    const f2 = path.join(root, "dir", "b.py");
    await writeFile(f1, "hello fs");
    await writeFile(f2, "print('x')\nhello");

    const backend = new FilesystemBackend({
      rootDir: root,
      virtualMode: false,
    });

    const infos = await backend.lsInfo(root);
    const paths = new Set(infos.map((i) => i.path));
    expect(paths.has(f1)).toBe(true);
    expect(paths.has(f2)).toBe(false);
    expect(paths.has(path.join(root, "dir") + path.sep)).toBe(true);

    const txt = await backend.read(f1);
    expect(txt).toContain("hello fs");

    const editMsg = await backend.edit(f1, "fs", "filesystem", false);
    expect(editMsg).toBeDefined();
    expect(editMsg.error).toBeUndefined();
    expect(editMsg.occurrences).toBe(1);

    const writeMsg = await backend.write(
      path.join(root, "new.txt"),
      "new content",
    );
    expect(writeMsg).toBeDefined();
    expect(writeMsg.error).toBeUndefined();
    expect(writeMsg.path).toContain("new.txt");

    const matches = await backend.grepRaw("hello", root);
    expect(Array.isArray(matches)).toBe(true);
    if (Array.isArray(matches)) {
      expect(matches.some((m) => m.path.endsWith("a.txt"))).toBe(true);
    }

    const globResults = await backend.globInfo("**/*.py", root);
    expect(globResults.some((i) => i.path === f2)).toBe(true);
  });

  it("should work in virtual mode with sandboxed paths", async () => {
    const root = tmpDir;
    const f1 = path.join(root, "a.txt");
    const f2 = path.join(root, "dir", "b.md");
    await writeFile(f1, "hello virtual");
    await writeFile(f2, "content");

    const backend = new FilesystemBackend({
      rootDir: root,
      virtualMode: true,
    });

    const infos = await backend.lsInfo("/");
    const paths = new Set(infos.map((i) => i.path));
    expect(paths.has("/a.txt")).toBe(true);
    expect(paths.has("/dir/b.md")).toBe(false);
    expect(paths.has("/dir/")).toBe(true);

    const txt = await backend.read("/a.txt");
    expect(txt).toContain("hello virtual");

    const editMsg = await backend.edit("/a.txt", "virtual", "virt", false);
    expect(editMsg).toBeDefined();
    expect(editMsg.error).toBeUndefined();
    expect(editMsg.occurrences).toBe(1);

    const writeMsg = await backend.write("/new.txt", "x");
    expect(writeMsg).toBeDefined();
    expect(writeMsg.error).toBeUndefined();
    expect(fsSync.existsSync(path.join(root, "new.txt"))).toBe(true);

    const matches = await backend.grepRaw("virt", "/");
    expect(Array.isArray(matches)).toBe(true);
    if (Array.isArray(matches)) {
      expect(matches.some((m) => m.path === "/a.txt")).toBe(true);
    }

    const globResults = await backend.globInfo("**/*.md", "/");
    expect(globResults.some((i) => i.path === "/dir/b.md")).toBe(true);

    const err = await backend.grepRaw("[", "/");
    expect(typeof err).toBe("string");

    const traversalError = await backend.read("/../a.txt");
    expect(traversalError).toContain("Error");
    expect(traversalError).toContain("Path traversal not allowed");
  });

  it("should list nested directories correctly in virtual mode", async () => {
    const root = tmpDir;

    const files: Record<string, string> = {
      [path.join(root, "config.json")]: "config",
      [path.join(root, "src", "main.py")]: "code",
      [path.join(root, "src", "utils", "helper.py")]: "utils code",
      [path.join(root, "src", "utils", "common.py")]: "common utils",
      [path.join(root, "docs", "readme.md")]: "documentation",
      [path.join(root, "docs", "api", "reference.md")]: "api docs",
    };

    for (const [filePath, content] of Object.entries(files)) {
      await writeFile(filePath, content);
    }

    const backend = new FilesystemBackend({
      rootDir: root,
      virtualMode: true,
    });

    const rootListing = await backend.lsInfo("/");
    const rootPaths = rootListing.map((fi) => fi.path);
    expect(rootPaths).toContain("/config.json");
    expect(rootPaths).toContain("/src/");
    expect(rootPaths).toContain("/docs/");
    expect(rootPaths).not.toContain("/src/main.py");
    expect(rootPaths).not.toContain("/src/utils/helper.py");

    const srcListing = await backend.lsInfo("/src/");
    const srcPaths = srcListing.map((fi) => fi.path);
    expect(srcPaths).toContain("/src/main.py");
    expect(srcPaths).toContain("/src/utils/");
    expect(srcPaths).not.toContain("/src/utils/helper.py");

    const utilsListing = await backend.lsInfo("/src/utils/");
    const utilsPaths = utilsListing.map((fi) => fi.path);
    expect(utilsPaths).toContain("/src/utils/helper.py");
    expect(utilsPaths).toContain("/src/utils/common.py");
    expect(utilsPaths.length).toBe(2);

    const emptyListing = await backend.lsInfo("/nonexistent/");
    expect(emptyListing).toEqual([]);
  });

  it("should list nested directories correctly in normal mode", async () => {
    const root = tmpDir;

    const files: Record<string, string> = {
      [path.join(root, "file1.txt")]: "content1",
      [path.join(root, "subdir", "file2.txt")]: "content2",
      [path.join(root, "subdir", "nested", "file3.txt")]: "content3",
    };

    for (const [filePath, content] of Object.entries(files)) {
      await writeFile(filePath, content);
    }

    const backend = new FilesystemBackend({
      rootDir: root,
      virtualMode: false,
    });

    const rootListing = await backend.lsInfo(root);
    const rootPaths = rootListing.map((fi) => fi.path);
    expect(rootPaths).toContain(path.join(root, "file1.txt"));
    expect(rootPaths).toContain(path.join(root, "subdir") + path.sep);
    expect(rootPaths).not.toContain(path.join(root, "subdir", "file2.txt"));

    const subdirListing = await backend.lsInfo(path.join(root, "subdir"));
    const subdirPaths = subdirListing.map((fi) => fi.path);
    expect(subdirPaths).toContain(path.join(root, "subdir", "file2.txt"));
    expect(subdirPaths).toContain(
      path.join(root, "subdir", "nested") + path.sep,
    );
    expect(subdirPaths).not.toContain(
      path.join(root, "subdir", "nested", "file3.txt"),
    );
  });

  it("should handle trailing slashes consistently", async () => {
    const root = tmpDir;

    const files: Record<string, string> = {
      [path.join(root, "file.txt")]: "content",
      [path.join(root, "dir", "nested.txt")]: "nested",
    };

    for (const [filePath, content] of Object.entries(files)) {
      await writeFile(filePath, content);
    }

    const backend = new FilesystemBackend({
      rootDir: root,
      virtualMode: true,
    });

    const listingWithSlash = await backend.lsInfo("/");
    expect(listingWithSlash.length).toBeGreaterThan(0);

    const listing = await backend.lsInfo("/");
    const paths = listing.map((fi) => fi.path);
    expect(paths).toEqual([...paths].sort());

    const listing1 = await backend.lsInfo("/dir/");
    const listing2 = await backend.lsInfo("/dir");
    expect(listing1.length).toBe(listing2.length);
    expect(listing1.map((fi) => fi.path)).toEqual(
      listing2.map((fi) => fi.path),
    );

    const empty = await backend.lsInfo("/nonexistent/");
    expect(empty).toEqual([]);
  });

  it("should handle large file writes correctly", async () => {
    const root = tmpDir;
    const backend = new FilesystemBackend({
      rootDir: root,
      virtualMode: true,
    });

    const largeContent = "f".repeat(10000);
    const writeResult = await backend.write("/large_file.txt", largeContent);

    expect(writeResult.error).toBeUndefined();
    expect(writeResult.path).toBe("/large_file.txt");

    const readContent = await backend.read("/large_file.txt");
    expect(readContent).toContain(largeContent.substring(0, 100));

    const savedFile = path.join(root, "large_file.txt");
    expect(fsSync.existsSync(savedFile)).toBe(true);
  });

  it("should read multiline content", async () => {
    const root = tmpDir;
    const filePath = path.join(root, "multiline.txt");
    await writeFile(filePath, "line1\nline2\nline3");

    const backend = new FilesystemBackend({
      rootDir: root,
      virtualMode: false,
    });

    const txt = await backend.read(filePath);
    expect(txt).toContain("line1");
    expect(txt).toContain("line2");
    expect(txt).toContain("line3");
  });

  it("should handle empty files", async () => {
    const root = tmpDir;
    const filePath = path.join(root, "empty.txt");
    await writeFile(filePath, "");

    const backend = new FilesystemBackend({
      rootDir: root,
      virtualMode: false,
    });

    const txt = await backend.read(filePath);
    expect(txt).toContain("empty contents");
  });

  it("should handle files with trailing newlines", async () => {
    const root = tmpDir;
    const filePath = path.join(root, "trailing.txt");
    await writeFile(filePath, "line1\nline2\n");

    const backend = new FilesystemBackend({
      rootDir: root,
      virtualMode: false,
    });

    const txt = await backend.read(filePath);
    expect(txt).toContain("line1");
    expect(txt).toContain("line2");
  });

  it("should handle unicode content", async () => {
    const root = tmpDir;
    const filePath = path.join(root, "unicode.txt");
    await writeFile(filePath, "Hello 世界\n🚀 emoji\nΩ omega");

    const backend = new FilesystemBackend({
      rootDir: root,
      virtualMode: false,
    });

    const txt = await backend.read(filePath);
    expect(txt).toContain("Hello 世界");
    expect(txt).toContain("🚀 emoji");
    expect(txt).toContain("Ω omega");
  });

  it("should handle non-existent files consistently", async () => {
    const root = tmpDir;
    const backend = new FilesystemBackend({
      rootDir: root,
      virtualMode: false,
    });

    const nonexistentPath = path.join(root, "nonexistent.txt");

    const readResult = await backend.read(nonexistentPath);
    expect(readResult).toContain("Error");
  });

  it("should handle symlinks securely", async () => {
    const root = tmpDir;
    const targetFile = path.join(root, "target.txt");
    const symlinkFile = path.join(root, "symlink.txt");

    await writeFile(targetFile, "target content");
    try {
      await fs.symlink(targetFile, symlinkFile);
    } catch {
      // Skip test if symlinks aren't supported (e.g., Windows without admin)
      return;
    }

    const backend = new FilesystemBackend({
      rootDir: root,
      virtualMode: false,
    });

    const readResult = await backend.read(symlinkFile);
    expect(readResult).toContain("Error");
  });
});

describe("FilesystemBackend streaming read", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(async () => {
    await removeDir(tmpDir);
  });

  it("should read with offset and limit", async () => {
    const filePath = path.join(tmpDir, "lines.txt");
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    await writeFile(filePath, lines.join("\n"));

    const backend = new FilesystemBackend({
      rootDir: tmpDir,
      virtualMode: false,
    });

    // Read lines 3-5 (offset=2, limit=3)
    const txt = await backend.read(filePath, 2, 3);
    expect(txt).toContain("line3");
    expect(txt).toContain("line4");
    expect(txt).toContain("line5");
    expect(txt).not.toContain("line2");
    expect(txt).not.toContain("line6");
  });

  it("should return error when offset exceeds file length", async () => {
    const filePath = path.join(tmpDir, "short.txt");
    await writeFile(filePath, "line1\nline2\nline3");

    const backend = new FilesystemBackend({
      rootDir: tmpDir,
      virtualMode: false,
    });

    const result = await backend.read(filePath, 100);
    expect(result).toContain("Error");
    expect(result).toContain("offset");
    expect(result).toContain("exceeds");
  });

  it("should handle whitespace-only file", async () => {
    const filePath = path.join(tmpDir, "whitespace.txt");
    await writeFile(filePath, "   \n\t  \n  ");

    const backend = new FilesystemBackend({
      rootDir: tmpDir,
      virtualMode: false,
    });

    const txt = await backend.read(filePath);
    expect(txt).toContain("empty contents");
  });

  it("should count trailing newline lines correctly", async () => {
    const filePath = path.join(tmpDir, "trailing.txt");
    // "line1\nline2\n" split("\n") produces ["line1", "line2", ""] => 3 lines
    await writeFile(filePath, "line1\nline2\n");

    const backend = new FilesystemBackend({
      rootDir: tmpDir,
      virtualMode: false,
    });

    // offset=2 targets the empty trailing line — should not error
    const txt2 = await backend.read(filePath, 2, 1);
    expect(txt2).not.toContain("Error");

    // offset=3 exceeds the 3-line file
    const txt3 = await backend.read(filePath, 3);
    expect(txt3).toContain("Error");
    expect(txt3).toContain("exceeds");
    expect(txt3).toContain("3 lines");
  });

  it("should count lines correctly without trailing newline", async () => {
    const filePath = path.join(tmpDir, "notrail.txt");
    // "line1\nline2" split("\n") produces ["line1", "line2"] => 2 lines
    await writeFile(filePath, "line1\nline2");

    const backend = new FilesystemBackend({
      rootDir: tmpDir,
      virtualMode: false,
    });

    const txt = await backend.read(filePath);
    expect(txt).toContain("line1");
    expect(txt).toContain("line2");

    // offset=2 exceeds the 2-line file
    const txt2 = await backend.read(filePath, 2);
    expect(txt2).toContain("Error");
    expect(txt2).toContain("exceeds");
    expect(txt2).toContain("2 lines");
  });

  it("should handle large file with offset efficiently", async () => {
    const filePath = path.join(tmpDir, "large.txt");
    const lines = Array.from({ length: 2000 }, (_, i) => `line${i + 1}`);
    await writeFile(filePath, lines.join("\n"));

    const backend = new FilesystemBackend({
      rootDir: tmpDir,
      virtualMode: false,
    });

    // Read lines 1001-1010
    const txt = await backend.read(filePath, 1000, 10);
    expect(txt).toContain("line1001");
    expect(txt).toContain("line1010");
    expect(txt).not.toContain("line1000");
    expect(txt).not.toContain("line1011");
  });

  it("should handle single-line file", async () => {
    const filePath = path.join(tmpDir, "single.txt");
    await writeFile(filePath, "only line");

    const backend = new FilesystemBackend({
      rootDir: tmpDir,
      virtualMode: false,
    });

    const txt = await backend.read(filePath);
    expect(txt).toContain("only line");
  });
});

describe("FilesystemBackend streaming grep", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(async () => {
    await removeDir(tmpDir);
  });

  it("should find matches across multiple files", async () => {
    await writeFile(path.join(tmpDir, "a.txt"), "hello world\nfoo bar");
    await writeFile(path.join(tmpDir, "b.txt"), "baz qux\nhello again");

    const backend = new FilesystemBackend({
      rootDir: tmpDir,
      virtualMode: false,
    });

    const matches = await backend.grepRaw("hello", tmpDir);
    expect(Array.isArray(matches)).toBe(true);
    if (Array.isArray(matches)) {
      expect(matches.length).toBeGreaterThanOrEqual(2);
      expect(
        matches.some((m) => m.path.endsWith("a.txt") && m.line === 1),
      ).toBe(true);
      expect(
        matches.some((m) => m.path.endsWith("b.txt") && m.line === 2),
      ).toBe(true);
    }
  });

  it("should handle unicode in search results", async () => {
    await writeFile(
      path.join(tmpDir, "uni.txt"),
      "Hello 世界\n🚀 emoji\nΩ omega",
    );

    const backend = new FilesystemBackend({
      rootDir: tmpDir,
      virtualMode: false,
    });

    const matches = await backend.grepRaw("世界", tmpDir);
    expect(Array.isArray(matches)).toBe(true);
    if (Array.isArray(matches)) {
      expect(matches.some((m) => m.text.includes("世界"))).toBe(true);
    }
  });
});
