#!/usr/bin/env python3
"""The Kitchen Codex — Phase 4.5A secure ZIP extraction helper.

BUILD-TIME / OFFLINE ONLY. This helper performs ONLY secure extraction of one
expected official JSON member from a pinned, SHA-256-verified USDA archive. It
never performs canonical record adaptation, numeric conversion, digest
construction, or manifest generation — those stay in TypeScript.

TOCTOU BINDING (audit repair)
-----------------------------
The exact bytes that are hashed MUST be the bytes opened as a ZIP archive. The
previous helper hashed an archive pathname and then independently reopened that
same mutable pathname for extraction, leaving a replacement/TOCTOU gap.

Now the archive is opened exactly once with low-level no-follow semantics
(`O_NOFOLLOW` where available), `fstat`ed and required to be a regular file, and
its open descriptor is stream-copied (while hashing) into a newly created private
temporary file inside a private, fresh, `0700` staging directory:

  * fixed private filename (never caller-controlled);
  * mode `0600`, exclusive creation (`O_CREAT | O_EXCL`);
  * bounded archive size;
  * the pinned SHA-256 is compared against the bytes just copied.

The private verified copy is the ONLY thing ever reopened for
`zipfile.ZipFile`; the original caller pathname is never reopened for ZIP
parsing. Opening by descriptor plus the private copy means pathname replacement
cannot substitute different extraction bytes: a replacement before staging is
either the file that gets hashed (and fails the pinned digest) or is rejected,
and in-place mutation during copying yields a digest mismatch. The private copy
is deleted during cleanup.

Policy (closed):
  * verify the archive SHA-256 BEFORE opening the ZIP;
  * reject encrypted members;
  * reject symlinks, directories-as-files, and unusual file types;
  * reject absolute paths, `..` traversal, backslash ambiguity, drive letters, NULs;
  * reject duplicate and case-colliding member names;
  * bound member count, per-member compressed/uncompressed size, total
    uncompressed size, and compression ratio;
  * validate the member CRC (zipfile does this while streaming to EOF);
  * allow only the exact expected member name (and harmless directory entries);
  * write only into a freshly created output directory; refuse overwrite;
  * remove partial output on any failure.

Exit: 0 with a bounded JSON result on success; 1 with a bounded JSON error code
on failure. No archive text, member text, or local path is ever echoed.
"""

import argparse
import hashlib
import json
import os
import shutil
import stat
import sys
import tempfile
import zipfile

ZIP_MAX_MEMBERS = 16
ZIP_MAX_MEMBER_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
ZIP_MAX_MEMBER_COMPRESSED_BYTES = 64 * 1024 * 1024
ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
ZIP_MAX_COMPRESSION_RATIO = 400
ZIP_MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
COPY_CHUNK = 1 << 20

# Fixed private filename; never derived from caller input.
PRIVATE_ARCHIVE_NAME = "archive.bin"


class ExtractError(Exception):
    """Fixed, bounded extraction failure code."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def emit(payload, code=0):
    sys.stdout.write(json.dumps(payload, separators=(",", ":"), sort_keys=True))
    sys.stdout.write("\n")
    sys.exit(code)


def fail(code):
    emit({"ok": False, "code": code}, 1)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(COPY_CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def unsafe_member_name(name):
    if "\x00" in name:
        return True
    if name.startswith("/") or name.startswith("\\"):
        return True
    if "\\" in name:
        return True
    if len(name) >= 2 and name[1] == ":":
        return True
    parts = name.split("/")
    for part in parts:
        if part == "..":
            return True
    return False


def stage_verified_archive(archive_path, expected_sha256, private_root, max_archive):
    """Open `archive_path` once, hash its exact open descriptor, and stream-copy
    those same bytes into a private 0600 file. Returns the private copy path.

    Raises `ExtractError` on any failure. The caller owns `private_root` cleanup.
    """
    if os.path.islink(archive_path):
        raise ExtractError("archive_is_symlink")

    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        src_fd = os.open(archive_path, flags)
    except OSError:
        # Includes symlink substitution (ELOOP) when O_NOFOLLOW is available.
        raise ExtractError("archive_open_failed")

    dest = os.path.join(private_root, PRIVATE_ARCHIVE_NAME)
    try:
        st = os.fstat(src_fd)
        if not stat.S_ISREG(st.st_mode):
            raise ExtractError("archive_not_regular_file")

        try:
            dst_fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except OSError:
            raise ExtractError("archive_staging_failed")

        h = hashlib.sha256()
        total = 0
        try:
            while True:
                chunk = os.read(src_fd, COPY_CHUNK)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_archive:
                    raise ExtractError("archive_too_large")
                h.update(chunk)
                view = memoryview(chunk)
                while view:
                    written = os.write(dst_fd, view)
                    view = view[written:]
        finally:
            os.close(dst_fd)

        if h.hexdigest() != expected_sha256:
            raise ExtractError("archive_digest_mismatch")
        return dest
    finally:
        os.close(src_fd)


def extract_member(private_archive, member, out, max_uncompressed, max_compressed, max_ratio):
    """Validate and extract the expected member from the private verified copy.

    The original caller pathname is never reopened here. Returns the number of
    bytes written.
    """
    try:
        archive = zipfile.ZipFile(private_archive)
    except Exception:
        raise ExtractError("invalid_zip")

    try:
        try:
            infos = archive.infolist()
        except Exception:
            raise ExtractError("invalid_zip")

        if len(infos) > ZIP_MAX_MEMBERS:
            raise ExtractError("too_many_members")

        seen = set()
        lower_seen = set()
        target = None
        total_uncompressed = 0
        for info in infos:
            name = info.filename
            if unsafe_member_name(name):
                raise ExtractError("unsafe_member_path")
            if name in seen or name.lower() in lower_seen:
                raise ExtractError("duplicate_member")
            seen.add(name)
            lower_seen.add(name.lower())
            if info.flag_bits & 0x1:
                raise ExtractError("encrypted_member")
            mode = info.external_attr >> 16
            if mode:
                file_type = stat.S_IFMT(mode)
                if file_type == stat.S_IFLNK:
                    raise ExtractError("symlink_member")
                if file_type not in (0, stat.S_IFREG, stat.S_IFDIR):
                    raise ExtractError("unusual_member_type")
            if name.endswith("/"):
                if info.file_size != 0:
                    raise ExtractError("invalid_directory_member")
                continue
            if name != member:
                raise ExtractError("unexpected_member")
            if info.file_size > max_uncompressed:
                raise ExtractError("member_too_large")
            if info.compress_size > max_compressed:
                raise ExtractError("member_compressed_too_large")
            if info.compress_size > 0 and info.file_size / info.compress_size > max_ratio:
                raise ExtractError("compression_ratio_too_high")
            total_uncompressed += info.file_size
            if total_uncompressed > ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES:
                raise ExtractError("total_uncompressed_too_large")
            target = info

        if target is None:
            raise ExtractError("expected_member_missing")

        try:
            os.makedirs(out, exist_ok=False)
        except OSError:
            raise ExtractError("output_exists")

        dest = os.path.join(out, "payload.json")
        written = 0
        try:
            with archive.open(target, "r") as source, open(dest, "xb") as sink:
                while True:
                    chunk = source.read(COPY_CHUNK)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > max_uncompressed:
                        raise ValueError("uncompressed_limit_exceeded")
                    sink.write(chunk)
        except Exception:
            shutil.rmtree(out, ignore_errors=True)
            raise ExtractError("extraction_failed")

        if written != target.file_size:
            shutil.rmtree(out, ignore_errors=True)
            raise ExtractError("size_mismatch")
        return written
    finally:
        archive.close()


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--archive", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--member", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--max-uncompressed", type=int, default=ZIP_MAX_MEMBER_UNCOMPRESSED_BYTES)
    parser.add_argument("--max-compressed", type=int, default=ZIP_MAX_MEMBER_COMPRESSED_BYTES)
    parser.add_argument("--max-ratio", type=int, default=ZIP_MAX_COMPRESSION_RATIO)
    parser.add_argument("--max-archive", type=int, default=ZIP_MAX_ARCHIVE_BYTES)
    args = parser.parse_args()

    if os.path.exists(args.out):
        fail("output_exists")

    private_root = tempfile.mkdtemp(prefix="kc-usda-zip-")
    try:
        try:
            private_archive = stage_verified_archive(
                args.archive, args.sha256, private_root, args.max_archive
            )
            written = extract_member(
                private_archive,
                args.member,
                args.out,
                args.max_uncompressed,
                args.max_compressed,
                args.max_ratio,
            )
        except ExtractError as error:
            shutil.rmtree(args.out, ignore_errors=True)
            fail(error.code)
        emit({"ok": True, "bytes": written, "sha256": sha256_file(os.path.join(args.out, "payload.json"))})
    finally:
        shutil.rmtree(private_root, ignore_errors=True)


if __name__ == "__main__":
    main()
