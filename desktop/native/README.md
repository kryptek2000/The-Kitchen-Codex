# Native Vault filesystem confinement helper

`tkc_vault.cc` is the privileged filesystem primitive used by the desktop main
process. It exposes only Vault-relative operations:

- text/binary read and atomic write;
- conditional text write;
- list/stat/exists;
- directory creation;
- removal.

Every operation:

1. opens the accepted real Vault root;
2. verifies its device/inode identity against the authorized root;
3. walks each path component using directory descriptors;
4. uses `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS |
   RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV)` where available, with a
   per-component `openat(..., O_NOFOLLOW)` fallback;
5. writes through a same-directory temporary file followed by `renameat`, so a
   failed write cannot truncate an existing recipe or asset.

There is no absolute operation path and no path-based fallback that follows an
intermediate symbolic link. A different directory at the authorized root path
fails the inode identity check.

## Build

```bash
npm run build:desktop:native
```

The build uses the host C++ compiler and N-API headers (`/usr/include/node` by
default; override with `TKC_NODE_HEADERS`). The resulting `.node` binary is a
Linux platform/architecture artifact and is copied into the desktop package by
`npm run desktop:package`. The source is the reviewable implementation; the
binary is generated and ignored by Git.

The packaged helper requires a Linux kernel with `openat2` for mount-point
crossing protection. Kernels without `openat2` use descriptor-relative
`openat(O_NOFOLLOW)` component traversal, which still prevents intermediate and
final symlink substitution but does not claim `NO_XDEV` mount protection.
