//! Native filesystem core for Ter Editor.
//!
//! Every path is validated against the open workspace root before touching disk,
//! so a compromised renderer cannot read or write outside the project folder.
//! Exposed to Node/Electron through N-API (ABI-stable, no Electron rebuild).

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rayon::prelude::*;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;
use walkdir::{DirEntry, WalkDir};

const MAX_INDEX_FILES: usize = 40_000;
const MAX_SEARCH_BYTES: u64 = 2_000_000;
const BINARY_SNIFF_BYTES: usize = 8_000;

const IGNORED_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    "dist",
    "dist-electron",
    "release",
    "out",
    "build",
    ".next",
    ".nuxt",
    ".cache",
    ".parcel-cache",
    "target",
    "vendor",
    ".venv",
    "venv",
    "__pycache__",
    ".idea",
    ".gradle",
    ".mypy_cache",
    ".pytest_cache",
    ".tox",
    "coverage",
    ".turbo",
    "native", // avoid indexing our own Rust build artefacts (native/target)
];

#[napi(object)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: i64,
    pub mtime: i64,
}

#[napi(object)]
pub struct Hit {
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub preview: String,
}

fn io_error(context: &str, error: std::io::Error) -> Error {
    Error::from_reason(format!("{context}: {error}"))
}

/// Lexical normalisation: resolves `.` and `..` without touching the filesystem.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn outside(target: &str) -> Error {
    Error::from_reason(format!("Path is outside the open folder: {target}"))
}

/// Resolves `target` inside `root`, rejecting anything that escapes the workspace.
///
/// The containment comparison uses canonical paths because workspace roots are
/// routinely symlinked or shortened by the OS: macOS maps `/var` to
/// `/private/var`, and Windows temp folders come back as 8.3 short names. The
/// returned path stays lexical so new files can be created inside a folder that
/// does not exist yet.
fn guard(root: &str, target: &str) -> Result<PathBuf> {
    let root_path = fs::canonicalize(root).map_err(|error| io_error("Cannot resolve workspace root", error))?;
    let raw = PathBuf::from(target);
    let absolute = if raw.is_absolute() { raw } else { root_path.join(raw) };
    let normalized = normalize(&absolute);

    // Walk up to the nearest path that exists, canonicalise that, and check it.
    let mut probe = normalized.clone();
    loop {
        if probe.exists() {
            break;
        }
        match probe.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => probe = parent.to_path_buf(),
            _ => return Err(outside(target)),
        }
    }

    let canonical_probe = fs::canonicalize(&probe).map_err(|error| io_error("Cannot resolve path", error))?;
    if !canonical_probe.starts_with(&root_path) {
        return Err(outside(target));
    }
    Ok(normalized)
}

fn is_ignored(entry: &DirEntry) -> bool {
    entry
        .file_name()
        .to_str()
        .map(|name| IGNORED_DIRS.contains(&name))
        .unwrap_or(false)
}

fn entry_for(path: &Path) -> Result<Entry> {
    let metadata = fs::metadata(path).map_err(|error| io_error("Cannot read metadata", error))?;
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    Ok(Entry {
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default(),
        path: path.to_string_lossy().to_string(),
        is_dir: metadata.is_dir(),
        size: metadata.len() as i64,
        mtime,
    })
}

fn looks_binary(head: &[u8]) -> bool {
    head.contains(&0)
}

#[napi]
pub fn native_version() -> String {
    format!("ter-fs {} ({})", env!("CARGO_PKG_VERSION"), std::env::consts::ARCH)
}

#[napi]
pub fn read_text(root: String, path: String) -> Result<String> {
    let target = guard(&root, &path)?;
    let metadata = fs::metadata(&target).map_err(|error| io_error("Cannot read file", error))?;
    if metadata.is_dir() {
        return Err(Error::from_reason(format!("{path} is a directory")));
    }
    let mut file = fs::File::open(&target).map_err(|error| io_error("Cannot open file", error))?;
    let mut head = vec![0u8; BINARY_SNIFF_BYTES.min(metadata.len() as usize)];
    if !head.is_empty() {
        file.read_exact(&mut head)
            .map_err(|error| io_error("Cannot read file", error))?;
    }
    if looks_binary(&head) {
        return Err(Error::from_reason(format!(
            "{} is a binary file and cannot be opened as text",
            Path::new(&path)
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or(path)
        )));
    }
    let mut contents = String::new();
    let mut file = fs::File::open(&target).map_err(|error| io_error("Cannot open file", error))?;
    file.read_to_string(&mut contents)
        .map_err(|error| io_error("File is not valid UTF-8 text", error))?;
    Ok(contents)
}

#[napi]
pub fn write_text(root: String, path: String, contents: String) -> Result<()> {
    let target = guard(&root, &path)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| io_error("Cannot create parent folder", error))?;
    }
    fs::write(&target, contents).map_err(|error| io_error("Cannot write file", error))
}

#[napi]
pub fn create_entry(root: String, path: String, kind: String) -> Result<()> {
    let target = guard(&root, &path)?;
    if kind == "folder" {
        fs::create_dir_all(&target).map_err(|error| io_error("Cannot create folder", error))?;
        return Ok(());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| io_error("Cannot create parent folder", error))?;
    }
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|error| io_error("Cannot create file", error))?;
    Ok(())
}

#[napi]
pub fn remove_entry(root: String, path: String) -> Result<()> {
    let target = guard(&root, &path)?;
    let root_path = fs::canonicalize(&root).map_err(|error| io_error("Cannot resolve workspace root", error))?;
    if target == root_path {
        return Err(Error::from_reason("Refusing to delete the open folder"));
    }
    if target.is_dir() {
        fs::remove_dir_all(&target).map_err(|error| io_error("Cannot delete folder", error))
    } else {
        fs::remove_file(&target).map_err(|error| io_error("Cannot delete file", error))
    }
}

#[napi]
pub fn rename_entry(root: String, from: String, to: String) -> Result<()> {
    let source = guard(&root, &from)?;
    let destination = guard(&root, &to)?;
    fs::metadata(&source).map_err(|error| io_error("Source does not exist", error))?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| io_error("Cannot create parent folder", error))?;
    }
    fs::rename(&source, &destination).map_err(|error| io_error("Cannot move path", error))
}

#[napi]
pub fn list_dir(root: String, path: String) -> Result<Vec<Entry>> {
    let target = guard(&root, &path)?;
    let mut entries = Vec::new();
    for item in fs::read_dir(&target).map_err(|error| io_error("Cannot list folder", error))? {
        let item = match item {
            Ok(item) => item,
            Err(_) => continue,
        };
        let name = item.file_name().to_string_lossy().to_string();
        if name == ".git" {
            continue;
        }
        if let Ok(entry) = entry_for(&item.path()) {
            entries.push(entry);
        }
    }
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

#[napi]
pub fn stat_path(root: String, path: String) -> Result<Entry> {
    let target = guard(&root, &path)?;
    entry_for(&target)
}

fn walk_files(root: &Path, max_files: usize) -> Vec<PathBuf> {
    WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| !(entry.file_type().is_dir() && is_ignored(entry)))
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .take(max_files)
        .collect()
}

#[napi]
pub fn index_files(root: String, max_files: Option<u32>) -> Result<Vec<String>> {
    let root_path = fs::canonicalize(&root).map_err(|error| io_error("Cannot resolve workspace root", error))?;
    let limit = max_files.map(|value| value as usize).unwrap_or(MAX_INDEX_FILES);
    Ok(walk_files(&root_path, limit)
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect())
}

fn subsequence(haystack: &str, needle: &str) -> bool {
    let mut chars = haystack.chars();
    needle.chars().all(|wanted| chars.any(|candidate| candidate == wanted))
}

#[napi]
pub fn find_files(root: String, query: String, limit: Option<u32>) -> Result<Vec<String>> {
    let root_path = fs::canonicalize(&root).map_err(|error| io_error("Cannot resolve workspace root", error))?;
    let files = walk_files(&root_path, MAX_INDEX_FILES);
    let limit = limit.map(|value| value as usize).unwrap_or(60);
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(files
            .into_iter()
            .take(limit)
            .map(|path| path.to_string_lossy().to_string())
            .collect());
    }
    let mut scored: Vec<(f64, PathBuf)> = files
        .into_par_iter()
        .filter_map(|path| {
            let base = path
                .file_name()
                .map(|name| name.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            let relative = path
                .strip_prefix(&root_path)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/")
                .to_lowercase();
            let score = if base == needle {
                1000.0
            } else if base.starts_with(&needle) {
                800.0
            } else if base.contains(&needle) {
                600.0
            } else if subsequence(&relative, &needle) {
                400.0 - relative.len() as f64 * 0.01
            } else {
                return None;
            };
            Some((score, path))
        })
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    Ok(scored
        .into_iter()
        .take(limit)
        .map(|(_, path)| path.to_string_lossy().to_string())
        .collect())
}

fn search_file(path: &Path, needle_lower: &str, max_hits: usize) -> Vec<Hit> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return Vec::new(),
    };
    if metadata.len() > MAX_SEARCH_BYTES {
        return Vec::new();
    }
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return Vec::new(),
    };
    if looks_binary(&bytes[..bytes.len().min(2048)]) {
        return Vec::new();
    }
    let contents = match String::from_utf8(bytes) {
        Ok(contents) => contents,
        Err(_) => return Vec::new(),
    };
    if !contents.to_lowercase().contains(needle_lower) {
        return Vec::new();
    }
    let mut hits = Vec::new();
    for (index, line) in contents.lines().enumerate() {
        let lowered = line.to_lowercase();
        if let Some(position) = lowered.find(needle_lower) {
            let preview: String = line.trim().chars().take(240).collect();
            hits.push(Hit {
                path: path.to_string_lossy().to_string(),
                line: index as u32 + 1,
                column: lowered[..position].chars().count() as u32 + 1,
                preview,
            });
            if hits.len() >= max_hits {
                break;
            }
        }
    }
    hits
}

#[napi]
pub fn search_text(root: String, query: String, max_hits: Option<u32>) -> Result<Vec<Hit>> {
    let root_path = fs::canonicalize(&root).map_err(|error| io_error("Cannot resolve workspace root", error))?;
    let needle = query.trim().to_string();
    if needle.len() < 2 {
        return Err(Error::from_reason("Search needs at least two characters"));
    }
    let needle_lower = needle.to_lowercase();
    let limit = max_hits.map(|value| value as usize).unwrap_or(200);
    let files = walk_files(&root_path, MAX_INDEX_FILES);
    let per_file = 20usize;
    let mut hits: Vec<Hit> = files
        .par_iter()
        .flat_map(|path| search_file(path, &needle_lower, per_file))
        .collect();
    hits.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    hits.truncate(limit);
    Ok(hits)
}
