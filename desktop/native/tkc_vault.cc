// The Kitchen Codex — native Vault filesystem confinement helper.
//
// This addon exposes only Vault-relative operations. Every operation opens the
// authorized root directory, verifies its device/inode identity, then walks the
// relative path one component at a time with directory descriptors. On Linux it
// uses openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS |
// RESOLVE_NO_XDEV); on kernels without openat2 it falls back to openat with
// O_NOFOLLOW per component. There is no path-based fallback that follows
// intermediate symlinks.
//
// Root identity is supplied by the main process from the accepted real Vault
// root. The helper never accepts an absolute operation path, never exposes a
// general-purpose filesystem API, and never follows a final or intermediate
// symbolic link.

#include <node_api.h>

#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <dirent.h>
#include <fcntl.h>
#include <unistd.h>

#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#ifdef __linux__
#include <linux/openat2.h>
#endif

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif
#ifndef O_NOFOLLOW
#define O_NOFOLLOW 0
#endif
#ifndef O_DIRECTORY
#define O_DIRECTORY 0
#endif
#ifndef O_PATH
#define O_PATH 0
#endif
#ifndef AT_SYMLINK_NOFOLLOW
#define AT_SYMLINK_NOFOLLOW 0
#endif

namespace {

constexpr uint64_t kResolveNoSymlinks =
#ifdef RESOLVE_NO_SYMLINKS
    RESOLVE_NO_SYMLINKS;
#else
    0;
#endif

constexpr uint64_t kResolveNoMagicLinks =
#ifdef RESOLVE_NO_MAGICLINKS
    RESOLVE_NO_MAGICLINKS;
#else
    0;
#endif

constexpr uint64_t kResolveBeneath =
#ifdef RESOLVE_BENEATH
    RESOLVE_BENEATH;
#else
    0;
#endif

constexpr uint64_t kResolveNoXdev =
#ifdef RESOLVE_NO_XDEV
    RESOLVE_NO_XDEV;
#else
    0;
#endif

bool g_openat2_supported = true;

struct Fd {
  int value = -1;
  Fd() = default;
  explicit Fd(int fd) : value(fd) {}
  Fd(const Fd&) = delete;
  Fd& operator=(const Fd&) = delete;
  Fd(Fd&& other) noexcept : value(other.value) { other.value = -1; }
  Fd& operator=(Fd&& other) noexcept {
    if (this != &other) {
      reset(other.value);
      other.value = -1;
    }
    return *this;
  }
  ~Fd() { reset(); }
  int release() {
    const int fd = value;
    value = -1;
    return fd;
  }
  void reset(int fd = -1) {
    if (value >= 0) {
      while (close(value) < 0 && errno == EINTR) {
      }
    }
    value = fd;
  }
};

struct Root {
  Fd fd;
  std::string path;
};

std::string errno_code(int error) {
  switch (error) {
    case EACCES:
      return "EACCES";
    case EEXIST:
      return "EEXIST";
    case EINVAL:
      return "EINVAL";
    case EIO:
      return "EIO";
    case EISDIR:
      return "EISDIR";
    case ELOOP:
      return "ELOOP";
    case ENAMETOOLONG:
      return "ENAMETOOLONG";
    case ENOENT:
      return "ENOENT";
    case ENOSPC:
      return "ENOSPC";
    case ENOTDIR:
      return "ENOTDIR";
    case EPERM:
      return "EPERM";
    case EROFS:
      return "EROFS";
    case EXDEV:
      return "EXDEV";
    default:
      return "EIO";
  }
}

void throw_code(napi_env env, const std::string& code, const std::string& message) {
  napi_value message_value = nullptr;
  napi_value error_value = nullptr;
  napi_value code_value = nullptr;
  napi_create_string_utf8(env, message.c_str(), NAPI_AUTO_LENGTH, &message_value);
  napi_create_error(env, nullptr, message_value, &error_value);
  napi_create_string_utf8(env, code.c_str(), NAPI_AUTO_LENGTH, &code_value);
  napi_set_named_property(env, error_value, "code", code_value);
  napi_throw(env, error_value);
}

void throw_path_error(napi_env env, const std::string& operation, const std::string& path, int error) {
  const std::string message =
      operation + " " + (path.empty() ? std::string(".") : path) + ": " + std::strerror(error);
  throw_code(env, errno_code(error), message);
}

void throw_symlink(napi_env env) {
  throw_code(env, "ELOOP", "Vault path must not contain symbolic links.");
}

void throw_root_changed(napi_env env) {
  throw_code(env, "DESKTOP_VAULT_ROOT_CHANGED", "The Vault directory was replaced. Re-select the Vault.");
}

bool get_string(napi_env env, napi_value value, std::string& result) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return false;
  std::vector<char> buffer(length + 1, '\0');
  size_t written = 0;
  if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &written) != napi_ok) {
    return false;
  }
  result.assign(buffer.data(), written);
  return true;
}

bool get_bool(napi_env env, napi_value value, bool& result) {
  bool converted = false;
  if (napi_get_value_bool(env, value, &converted) != napi_ok) return false;
  result = converted;
  return true;
}

bool parse_u64(napi_env env, napi_value value, uint64_t& result) {
  std::string text;
  if (!get_string(env, value, text) || text.empty()) return false;
  char* end = nullptr;
  errno = 0;
  const unsigned long long parsed = std::strtoull(text.c_str(), &end, 10);
  if (errno != 0 || end == text.c_str() || *end != '\0') return false;
  result = static_cast<uint64_t>(parsed);
  return true;
}

int openat2_component(int dirfd, const char* name, int flags, mode_t mode, uint64_t resolve) {
#ifdef SYS_openat2
  if (g_openat2_supported) {
    struct open_how how {};
    how.flags = static_cast<uint64_t>(flags | O_CLOEXEC);
    how.mode = static_cast<uint64_t>(mode);
    how.resolve = resolve;
    const int fd = static_cast<int>(syscall(SYS_openat2, dirfd, name, &how, sizeof(how)));
    if (fd >= 0) return fd;
    if (errno == ENOSYS || errno == EINVAL) {
      // EINVAL can mean an unsupported resolve flag on an older kernel. The
      // single-component openat fallback below still uses O_NOFOLLOW.
      g_openat2_supported = false;
    } else {
      return -1;
    }
  }
#endif
  return openat(dirfd, name, flags | O_NOFOLLOW | O_CLOEXEC, mode);
}

int open_dir_component(int dirfd, const char* name) {
  return openat2_component(
      dirfd,
      name,
      O_RDONLY | O_DIRECTORY,
      0,
      kResolveBeneath | kResolveNoSymlinks | kResolveNoMagicLinks | kResolveNoXdev);
}

int open_file_component(int dirfd, const char* name, int flags, mode_t mode) {
  return openat2_component(
      dirfd,
      name,
      flags,
      mode,
      kResolveBeneath | kResolveNoSymlinks | kResolveNoMagicLinks | kResolveNoXdev);
}

int open_root_path(const char* path) {
#ifdef SYS_openat2
  if (g_openat2_supported) {
    struct open_how how {};
    how.flags = static_cast<uint64_t>(O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    how.mode = 0;
    how.resolve = kResolveNoSymlinks | kResolveNoMagicLinks;
    const int fd = static_cast<int>(syscall(SYS_openat2, AT_FDCWD, path, &how, sizeof(how)));
    if (fd >= 0) return fd;
    if (errno != ENOSYS && errno != EINVAL) return -1;
    g_openat2_supported = false;
  }
#endif
  return open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
}

bool split_relative(
    const std::string& relative,
    bool allowEmpty,
    std::vector<std::string>& parts,
    std::string& error) {
  parts.clear();
  if (relative.empty()) {
    if (allowEmpty) return true;
    error = "A Vault file path is required.";
    return false;
  }
  if (relative.find('\0') != std::string::npos) {
    error = "Vault paths must not contain NUL bytes.";
    return false;
  }
  if (relative.front() == '/') {
    error = "Absolute vault paths are not allowed.";
    return false;
  }
  size_t start = 0;
  while (start <= relative.size()) {
    const size_t slash = relative.find('/', start);
    const size_t end = slash == std::string::npos ? relative.size() : slash;
    const std::string part = relative.substr(start, end - start);
    if (part.empty() || part == "." || part == ".." || part.find('\\') != std::string::npos) {
      error = "Invalid vault path segment.";
      return false;
    }
    parts.push_back(part);
    if (slash == std::string::npos) break;
    start = slash + 1;
  }
  return !parts.empty();
}

bool open_root_checked(
    napi_env env,
    napi_value root_value,
    napi_value dev_value,
    napi_value ino_value,
    Root& root) {
  std::string root_path;
  uint64_t expected_dev = 0;
  uint64_t expected_ino = 0;
  if (!get_string(env, root_value, root_path) || root_path.empty() ||
      root_path.front() != '/' || root_path.find('\0') != std::string::npos) {
    throw_code(env, "EINVAL", "An absolute authorized Vault root is required.");
    return false;
  }
  if (!parse_u64(env, dev_value, expected_dev) || !parse_u64(env, ino_value, expected_ino)) {
    throw_code(env, "EINVAL", "The Vault root identity is invalid.");
    return false;
  }

  const int fd = open_root_path(root_path.c_str());
  if (fd < 0) {
    throw_path_error(env, "open Vault root", root_path, errno);
    return false;
  }
  root.fd.reset(fd);
  root.path = root_path;

  struct stat stat_value {};
  if (fstat(root.fd.value, &stat_value) != 0) {
    throw_path_error(env, "stat Vault root", root_path, errno);
    return false;
  }
  if (!S_ISDIR(stat_value.st_mode)) {
    throw_code(env, "ENOTDIR", "The Vault root is not a directory.");
    return false;
  }
  if (static_cast<uint64_t>(stat_value.st_dev) != expected_dev ||
      static_cast<uint64_t>(stat_value.st_ino) != expected_ino) {
    throw_root_changed(env);
    return false;
  }
  return true;
}

bool walk_parent(
    napi_env env,
    Root& root,
    const std::vector<std::string>& parts,
    bool create_missing,
    Fd& parent) {
  if (parts.empty()) {
    parent = Fd(dup(root.fd.value));
    if (parent.value < 0) {
      throw_path_error(env, "duplicate Vault root", root.path, errno);
      return false;
    }
    return true;
  }

  Fd current(dup(root.fd.value));
  if (current.value < 0) {
    throw_path_error(env, "duplicate Vault root", root.path, errno);
    return false;
  }

  for (size_t index = 0; index + 1 < parts.size(); ++index) {
    const std::string& component = parts[index];
    int next = open_dir_component(current.value, component.c_str());
    if (next < 0 && errno == ENOENT && create_missing) {
      if (mkdirat(current.value, component.c_str(), 0755) != 0 && errno != EEXIST) {
        throw_path_error(env, "create Vault directory", component, errno);
        return false;
      }
      next = open_dir_component(current.value, component.c_str());
    }
    if (next < 0) {
      if (errno == ELOOP) throw_symlink(env);
      else throw_path_error(env, "open Vault directory", component, errno);
      return false;
    }
    current.reset(next);
  }
  parent = std::move(current);
  return true;
}

bool ensure_directory(
    napi_env env,
    Root& root,
    const std::vector<std::string>& parts) {
  if (parts.empty()) return true;

  Fd current(dup(root.fd.value));
  if (current.value < 0) {
    throw_path_error(env, "duplicate Vault root", root.path, errno);
    return false;
  }

  for (const std::string& component : parts) {
    int next = open_dir_component(current.value, component.c_str());
    if (next < 0 && errno == ENOENT) {
      if (mkdirat(current.value, component.c_str(), 0755) != 0 && errno != EEXIST) {
        throw_path_error(env, "create Vault directory", component, errno);
        return false;
      }
      next = open_dir_component(current.value, component.c_str());
    }
    if (next < 0) {
      if (errno == ELOOP) throw_symlink(env);
      else throw_path_error(env, "open Vault directory", component, errno);
      return false;
    }
    current.reset(next);
  }
  return true;
}

bool lstat_leaf(
    napi_env env,
    int parent_fd,
    const std::string& leaf,
    struct stat& stat_value,
    bool& exists) {
  if (fstatat(parent_fd, leaf.c_str(), &stat_value, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno == ENOENT) {
      exists = false;
      return true;
    }
    throw_path_error(env, "stat Vault path", leaf, errno);
    return false;
  }
  exists = true;
  return true;
}

bool read_all(napi_env env, int fd, std::string& result) {
  result.clear();
  char buffer[65536];
  for (;;) {
    const ssize_t count = read(fd, buffer, sizeof(buffer));
    if (count < 0) {
      if (errno == EINTR) continue;
      throw_path_error(env, "read Vault file", "", errno);
      return false;
    }
    if (count == 0) return true;
    result.append(buffer, static_cast<size_t>(count));
  }
}

bool write_all(napi_env env, int fd, const void* data, size_t length) {
  const char* cursor = static_cast<const char*>(data);
  size_t remaining = length;
  while (remaining > 0) {
    const ssize_t count = write(fd, cursor, remaining);
    if (count < 0) {
      if (errno == EINTR) continue;
      throw_path_error(env, "write Vault file", "", errno);
      return false;
    }
    if (count == 0) {
      throw_code(env, "EIO", "The Vault write made no progress.");
      return false;
    }
    cursor += count;
    remaining -= static_cast<size_t>(count);
  }
  return true;
}

bool sync_fd(int fd) {
  while (fsync(fd) != 0) {
    if (errno == EINTR) continue;
    return false;
  }
  return true;
}

bool atomic_write(
    napi_env env,
    int parent_fd,
    const std::string& leaf,
    const void* data,
    size_t length,
    bool exclusive) {
  struct stat existing {};
  bool exists = false;
  if (!lstat_leaf(env, parent_fd, leaf, existing, exists)) return false;
  if (exists) {
    if (S_ISLNK(existing.st_mode)) {
      throw_symlink(env);
      return false;
    }
    if (S_ISDIR(existing.st_mode)) {
      throw_code(env, "EISDIR", "Vault path is a directory, not a file.");
      return false;
    }
    if (!S_ISREG(existing.st_mode)) {
      throw_code(env, "EINVAL", "Vault path is not a regular file.");
      return false;
    }
  }

  if (exclusive) {
    if (exists) {
      throw_code(env, "EEXIST", "Vault path already exists.");
      return false;
    }
    const int fd = open_file_component(
        parent_fd, leaf.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0666);
    if (fd < 0) {
      if (errno == ELOOP) throw_symlink(env);
      else throw_path_error(env, "create Vault file", leaf, errno);
      return false;
    }
    Fd file(fd);
    if (!write_all(env, file.value, data, length)) {
      unlinkat(parent_fd, leaf.c_str(), 0);
      return false;
    }
    if (!sync_fd(file.value)) {
      const int error = errno;
      unlinkat(parent_fd, leaf.c_str(), 0);
      throw_path_error(env, "sync Vault file", leaf, error);
      return false;
    }
    return true;
  }

  char temporary[128];
  int temporary_fd = -1;
  for (unsigned attempt = 0; attempt < 32; ++attempt) {
    std::snprintf(
        temporary,
        sizeof(temporary),
        ".tkc-tmp-%ld-%u-%u",
        static_cast<long>(getpid()),
        attempt,
        static_cast<unsigned>(std::rand()));
    temporary_fd = open_file_component(
        parent_fd,
        temporary,
        O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC,
        0666);
    if (temporary_fd >= 0) break;
    if (errno != EEXIST) {
      if (errno == ELOOP) throw_symlink(env);
      else throw_path_error(env, "create temporary Vault file", temporary, errno);
      return false;
    }
  }
  if (temporary_fd < 0) {
    throw_code(env, "EEXIST", "Could not allocate a temporary Vault file.");
    return false;
  }
  Fd file(temporary_fd);

  if (exists) {
    // Preserve the previous file mode; ownership stays with the current user.
    if (fchmod(file.value, existing.st_mode & 0777) != 0) {
      throw_path_error(env, "set Vault file mode", temporary, errno);
      unlinkat(parent_fd, temporary, 0);
      return false;
    }
  }

  if (!write_all(env, file.value, data, length)) {
    unlinkat(parent_fd, temporary, 0);
    return false;
  }
  if (!sync_fd(file.value)) {
    const int error = errno;
    unlinkat(parent_fd, temporary, 0);
    throw_path_error(env, "sync Vault file", temporary, error);
    return false;
  }
  file.reset();

  if (renameat(parent_fd, temporary, parent_fd, leaf.c_str()) != 0) {
    const int error = errno;
    unlinkat(parent_fd, temporary, 0);
    throw_path_error(env, "replace Vault file", leaf, error);
    return false;
  }
  // Directory fsync is best-effort; the atomic rename is the integrity boundary.
  sync_fd(parent_fd);
  return true;
}

bool remove_tree_at(napi_env env, int parent_fd, const std::string& name) {
  const int dir_fd = open_dir_component(parent_fd, name.c_str());
  if (dir_fd < 0) {
    if (errno == ELOOP) throw_symlink(env);
    else throw_path_error(env, "open Vault directory", name, errno);
    return false;
  }
  DIR* directory = fdopendir(dir_fd);
  if (!directory) {
    close(dir_fd);
    throw_path_error(env, "read Vault directory", name, errno);
    return false;
  }

  bool ok = true;
  for (;;) {
    errno = 0;
    struct dirent* entry = readdir(directory);
    if (!entry) {
      if (errno != 0) {
        throw_path_error(env, "read Vault directory", name, errno);
        ok = false;
      }
      break;
    }
    const std::string child = entry->d_name;
    if (child == "." || child == "..") continue;

    struct stat stat_value {};
    if (fstatat(dirfd(directory), child.c_str(), &stat_value, AT_SYMLINK_NOFOLLOW) != 0) {
      if (errno == ENOENT) continue;
      throw_path_error(env, "stat Vault entry", child, errno);
      ok = false;
      break;
    }
    if (S_ISDIR(stat_value.st_mode)) {
      if (!remove_tree_at(env, dirfd(directory), child)) {
        ok = false;
        break;
      }
    } else {
      if (unlinkat(dirfd(directory), child.c_str(), 0) != 0 && errno != ENOENT) {
        throw_path_error(env, "remove Vault entry", child, errno);
        ok = false;
        break;
      }
    }
  }
  closedir(directory);
  if (!ok) return false;

  if (unlinkat(parent_fd, name.c_str(), AT_REMOVEDIR) != 0) {
    throw_path_error(env, "remove Vault directory", name, errno);
    return false;
  }
  return true;
}

bool get_args(
    napi_env env,
    napi_callback_info info,
    size_t expected,
    napi_value* args) {
  size_t argc = expected;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok) {
    throw_code(env, "EINVAL", "Could not read native Vault arguments.");
    return false;
  }
  if (argc < expected) {
    throw_code(env, "EINVAL", "Missing native Vault arguments.");
    return false;
  }
  return true;
}

napi_value ReadText(napi_env env, napi_callback_info info) {
  napi_value args[4];
  if (!get_args(env, info, 4, args)) return nullptr;
  Root root;
  if (!open_root_checked(env, args[0], args[2], args[3], root)) return nullptr;
  std::string relative;
  std::vector<std::string> parts;
  std::string error;
  if (!get_string(env, args[1], relative) ||
      !split_relative(relative, false, parts, error)) {
    throw_code(env, "EINVAL", error.empty() ? "Invalid Vault path." : error);
    return nullptr;
  }
  Fd parent;
  if (!walk_parent(env, root, parts, false, parent)) return nullptr;
  const int fd = open_file_component(parent.value, parts.back().c_str(), O_RDONLY | O_CLOEXEC, 0);
  if (fd < 0) {
    if (errno == ELOOP) throw_symlink(env);
    else throw_path_error(env, "open Vault file", relative, errno);
    return nullptr;
  }
  Fd file(fd);
  struct stat stat_value {};
  if (fstat(file.value, &stat_value) != 0) {
    throw_path_error(env, "stat Vault file", relative, errno);
    return nullptr;
  }
  if (!S_ISREG(stat_value.st_mode)) {
    throw_code(env, "EINVAL", "Vault path is not a regular file.");
    return nullptr;
  }
  std::string content;
  if (!read_all(env, file.value, content)) return nullptr;
  napi_value result = nullptr;
  napi_create_string_utf8(env, content.data(), content.size(), &result);
  return result;
}

napi_value ReadBinary(napi_env env, napi_callback_info info) {
  napi_value args[4];
  if (!get_args(env, info, 4, args)) return nullptr;
  Root root;
  if (!open_root_checked(env, args[0], args[2], args[3], root)) return nullptr;
  std::string relative;
  std::vector<std::string> parts;
  std::string error;
  if (!get_string(env, args[1], relative) ||
      !split_relative(relative, false, parts, error)) {
    throw_code(env, "EINVAL", error.empty() ? "Invalid Vault path." : error);
    return nullptr;
  }
  Fd parent;
  if (!walk_parent(env, root, parts, false, parent)) return nullptr;
  const int fd = open_file_component(parent.value, parts.back().c_str(), O_RDONLY | O_CLOEXEC, 0);
  if (fd < 0) {
    if (errno == ELOOP) throw_symlink(env);
    else throw_path_error(env, "open Vault file", relative, errno);
    return nullptr;
  }
  Fd file(fd);
  struct stat stat_value {};
  if (fstat(file.value, &stat_value) != 0) {
    throw_path_error(env, "stat Vault file", relative, errno);
    return nullptr;
  }
  if (!S_ISREG(stat_value.st_mode)) {
    throw_code(env, "EINVAL", "Vault path is not a regular file.");
    return nullptr;
  }
  std::string content;
  if (!read_all(env, file.value, content)) return nullptr;
  napi_value result = nullptr;
  void* copied = nullptr;
  if (napi_create_buffer_copy(env, content.size(), content.data(), &copied, &result) != napi_ok) {
    throw_code(env, "EIO", "Could not allocate the Vault binary result.");
    return nullptr;
  }
  return result;
}

napi_value WriteText(napi_env env, napi_callback_info info) {
  napi_value args[6];
  size_t argc = 6;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc < 5) {
    throw_code(env, "EINVAL", "Missing native Vault arguments.");
    return nullptr;
  }
  bool exclusive = false;
  if (argc >= 6 && !get_bool(env, args[5], exclusive)) {
    throw_code(env, "EINVAL", "The exclusive flag is invalid.");
    return nullptr;
  }
  Root root;
  if (!open_root_checked(env, args[0], args[3], args[4], root)) return nullptr;
  std::string relative;
  std::string content;
  std::vector<std::string> parts;
  std::string error;
  if (!get_string(env, args[1], relative) || !get_string(env, args[2], content) ||
      !split_relative(relative, false, parts, error)) {
    throw_code(env, "EINVAL", error.empty() ? "Invalid Vault path." : error);
    return nullptr;
  }
  Fd parent;
  if (!walk_parent(env, root, parts, true, parent)) return nullptr;
  if (!atomic_write(env, parent.value, parts.back(), content.data(), content.size(), exclusive)) {
    return nullptr;
  }
  return nullptr;
}

napi_value WriteBinary(napi_env env, napi_callback_info info) {
  napi_value args[6];
  size_t argc = 6;
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc < 5) {
    throw_code(env, "EINVAL", "Missing native Vault arguments.");
    return nullptr;
  }
  bool exclusive = false;
  if (argc >= 6 && !get_bool(env, args[5], exclusive)) {
    throw_code(env, "EINVAL", "The exclusive flag is invalid.");
    return nullptr;
  }
  Root root;
  if (!open_root_checked(env, args[0], args[3], args[4], root)) return nullptr;
  std::string relative;
  std::vector<std::string> parts;
  std::string error;
  if (!get_string(env, args[1], relative) ||
      !split_relative(relative, false, parts, error)) {
    throw_code(env, "EINVAL", error.empty() ? "Invalid Vault path." : error);
    return nullptr;
  }
  bool is_buffer = false;
  if (napi_is_buffer(env, args[2], &is_buffer) != napi_ok || !is_buffer) {
    throw_code(env, "EINVAL", "Binary Vault content must be a Buffer.");
    return nullptr;
  }
  void* data = nullptr;
  size_t length = 0;
  if (napi_get_buffer_info(env, args[2], &data, &length) != napi_ok) {
    throw_code(env, "EINVAL", "Could not read binary Vault content.");
    return nullptr;
  }
  Fd parent;
  if (!walk_parent(env, root, parts, true, parent)) return nullptr;
  if (!atomic_write(env, parent.value, parts.back(), data, length, exclusive)) return nullptr;
  return nullptr;
}

napi_value WriteTextIfUnchanged(napi_env env, napi_callback_info info) {
  napi_value args[6];
  if (!get_args(env, info, 6, args)) return nullptr;
  Root root;
  if (!open_root_checked(env, args[0], args[4], args[5], root)) return nullptr;
  std::string relative;
  std::string content;
  std::string expected;
  std::vector<std::string> parts;
  std::string error;
  if (!get_string(env, args[1], relative) || !get_string(env, args[2], content) ||
      !get_string(env, args[3], expected) ||
      !split_relative(relative, false, parts, error)) {
    throw_code(env, "EINVAL", error.empty() ? "Invalid Vault path." : error);
    return nullptr;
  }
  Fd parent;
  if (!walk_parent(env, root, parts, false, parent)) return nullptr;
  const int fd = open_file_component(parent.value, parts.back().c_str(), O_RDONLY | O_CLOEXEC, 0);
  if (fd < 0) {
    if (errno == ELOOP) throw_symlink(env);
    else throw_path_error(env, "open Vault file", relative, errno);
    return nullptr;
  }
  Fd current(fd);
  std::string current_content;
  if (!read_all(env, current.value, current_content)) return nullptr;
  if (current_content != expected) {
    throw_code(env, "ESTALE", "The recipe changed on disk since it was opened. The save was not applied.");
    return nullptr;
  }
  if (!atomic_write(env, parent.value, parts.back(), content.data(), content.size(), false)) {
    return nullptr;
  }
  return nullptr;
}

napi_value List(napi_env env, napi_callback_info info) {
  napi_value args[4];
  if (!get_args(env, info, 4, args)) return nullptr;
  Root root;
  if (!open_root_checked(env, args[0], args[2], args[3], root)) return nullptr;
  std::string relative;
  std::vector<std::string> parts;
  std::string error;
  if (!get_string(env, args[1], relative) ||
      !split_relative(relative, true, parts, error)) {
    throw_code(env, "EINVAL", error.empty() ? "Invalid Vault path." : error);
    return nullptr;
  }
  Fd directory_fd(dup(root.fd.value));
  if (directory_fd.value < 0) {
    throw_path_error(env, "duplicate Vault root", root.path, errno);
    return nullptr;
  }
  for (const std::string& component : parts) {
    const int next = open_dir_component(directory_fd.value, component.c_str());
    if (next < 0) {
      if (errno == ELOOP) throw_symlink(env);
      else throw_path_error(env, "open Vault directory", component, errno);
      return nullptr;
    }
    directory_fd.reset(next);
  }

  const int raw_directory_fd = directory_fd.release();
  DIR* directory = fdopendir(raw_directory_fd);
  if (!directory) {
    const int error = errno;
    close(raw_directory_fd);
    throw_path_error(env, "read Vault directory", relative, error);
    return nullptr;
  }
  std::vector<std::pair<std::string, std::string>> entries;
  for (;;) {
    errno = 0;
    struct dirent* entry = readdir(directory);
    if (!entry) {
      if (errno != 0) {
        throw_path_error(env, "read Vault directory", relative, errno);
        closedir(directory);
        return nullptr;
      }
      break;
    }
    const std::string name = entry->d_name;
    if (name == "." || name == "..") continue;
    struct stat stat_value {};
    if (fstatat(dirfd(directory), name.c_str(), &stat_value, AT_SYMLINK_NOFOLLOW) != 0) {
      if (errno == ENOENT) continue;
      throw_path_error(env, "stat Vault entry", name, errno);
      closedir(directory);
      return nullptr;
    }
    if (S_ISLNK(stat_value.st_mode)) continue;
    entries.emplace_back(name, S_ISDIR(stat_value.st_mode) ? "directory" : "file");
  }
  closedir(directory);

  napi_value result = nullptr;
  napi_create_array_with_length(env, entries.size(), &result);
  for (size_t index = 0; index < entries.size(); ++index) {
    napi_value object = nullptr;
    napi_value name = nullptr;
    napi_value kind = nullptr;
    napi_create_object(env, &object);
    napi_create_string_utf8(env, entries[index].first.c_str(), NAPI_AUTO_LENGTH, &name);
    napi_create_string_utf8(env, entries[index].second.c_str(), NAPI_AUTO_LENGTH, &kind);
    napi_set_named_property(env, object, "name", name);
    napi_set_named_property(env, object, "kind", kind);
    napi_set_element(env, result, static_cast<uint32_t>(index), object);
  }
  return result;
}

bool stat_relative(
    napi_env env,
    Root& root,
    const std::string& relative,
    struct stat& stat_value,
    bool& exists) {
  std::vector<std::string> parts;
  std::string error;
  if (!split_relative(relative, true, parts, error)) {
    throw_code(env, "EINVAL", error.empty() ? "Invalid Vault path." : error);
    return false;
  }
  if (parts.empty()) {
    if (fstat(root.fd.value, &stat_value) != 0) {
      throw_path_error(env, "stat Vault root", relative, errno);
      return false;
    }
    exists = true;
    return true;
  }
  Fd parent;
  if (!walk_parent(env, root, parts, false, parent)) return false;
  if (fstatat(parent.value, parts.back().c_str(), &stat_value, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno == ENOENT) {
      exists = false;
      return true;
    }
    throw_path_error(env, "stat Vault path", relative, errno);
    return false;
  }
  if (S_ISLNK(stat_value.st_mode)) {
    throw_symlink(env);
    return false;
  }
  exists = true;
  return true;
}

napi_value Stat(napi_env env, napi_callback_info info) {
  napi_value args[4];
  if (!get_args(env, info, 4, args)) return nullptr;
  Root root;
  if (!open_root_checked(env, args[0], args[2], args[3], root)) return nullptr;
  std::string relative;
  if (!get_string(env, args[1], relative)) {
    throw_code(env, "EINVAL", "Invalid Vault path.");
    return nullptr;
  }
  struct stat stat_value {};
  bool exists = false;
  if (!stat_relative(env, root, relative, stat_value, exists)) return nullptr;
  if (!exists) {
    throw_code(env, "ENOENT", "Vault path not found.");
    return nullptr;
  }
  napi_value result = nullptr;
  napi_value kind = nullptr;
  napi_value size = nullptr;
  napi_value mtime = nullptr;
  napi_create_object(env, &result);
  napi_create_string_utf8(env, S_ISDIR(stat_value.st_mode) ? "directory" : "file", NAPI_AUTO_LENGTH, &kind);
  napi_create_double(env, static_cast<double>(stat_value.st_size), &size);
  const double mtime_ms =
      static_cast<double>(stat_value.st_mtim.tv_sec) * 1000.0 +
      static_cast<double>(stat_value.st_mtim.tv_nsec) / 1000000.0;
  napi_create_double(env, mtime_ms, &mtime);
  napi_set_named_property(env, result, "kind", kind);
  napi_set_named_property(env, result, "size", size);
  napi_set_named_property(env, result, "mtimeMs", mtime);
  return result;
}

napi_value Exists(napi_env env, napi_callback_info info) {
  napi_value args[4];
  if (!get_args(env, info, 4, args)) return nullptr;
  Root root;
  if (!open_root_checked(env, args[0], args[2], args[3], root)) return nullptr;
  std::string relative;
  if (!get_string(env, args[1], relative)) {
    throw_code(env, "EINVAL", "Invalid Vault path.");
    return nullptr;
  }
  struct stat stat_value {};
  bool exists = false;
  if (!stat_relative(env, root, relative, stat_value, exists)) {
    // A symlink path is not an existing Vault entry. Clear the pending error
    // from stat_relative before returning the false result.
    bool pending = false;
    napi_is_exception_pending(env, &pending);
    if (pending) {
      napi_value ignored = nullptr;
      napi_get_and_clear_last_exception(env, &ignored);
    }
    exists = false;
  }
  napi_value result = nullptr;
  napi_get_boolean(env, exists, &result);
  return result;
}

napi_value Mkdir(napi_env env, napi_callback_info info) {
  napi_value args[4];
  if (!get_args(env, info, 4, args)) return nullptr;
  Root root;
  if (!open_root_checked(env, args[0], args[2], args[3], root)) return nullptr;
  std::string relative;
  std::vector<std::string> parts;
  std::string error;
  if (!get_string(env, args[1], relative) ||
      !split_relative(relative, true, parts, error)) {
    throw_code(env, "EINVAL", error.empty() ? "Invalid Vault path." : error);
    return nullptr;
  }
  if (!ensure_directory(env, root, parts)) return nullptr;
  return nullptr;
}

napi_value Remove(napi_env env, napi_callback_info info) {
  napi_value args[4];
  if (!get_args(env, info, 4, args)) return nullptr;
  Root root;
  if (!open_root_checked(env, args[0], args[2], args[3], root)) return nullptr;
  std::string relative;
  std::vector<std::string> parts;
  std::string error;
  if (!get_string(env, args[1], relative) ||
      !split_relative(relative, false, parts, error)) {
    throw_code(env, "EINVAL", error.empty() ? "Invalid Vault path." : error);
    return nullptr;
  }
  Fd parent;
  if (!walk_parent(env, root, parts, false, parent)) return nullptr;
  struct stat stat_value {};
  bool exists = false;
  if (!lstat_leaf(env, parent.value, parts.back(), stat_value, exists)) return nullptr;
  if (!exists) {
    throw_code(env, "ENOENT", "Vault path not found.");
    return nullptr;
  }
  if (S_ISLNK(stat_value.st_mode)) {
    throw_symlink(env);
    return nullptr;
  }
  if (S_ISDIR(stat_value.st_mode)) {
    if (!remove_tree_at(env, parent.value, parts.back())) return nullptr;
  } else {
    if (unlinkat(parent.value, parts.back().c_str(), 0) != 0) {
      throw_path_error(env, "remove Vault file", relative, errno);
      return nullptr;
    }
  }
  return nullptr;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"readText", nullptr, ReadText, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"readBinary", nullptr, ReadBinary, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"writeText", nullptr, WriteText, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"writeBinary", nullptr, WriteBinary, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"writeTextIfUnchanged", nullptr, WriteTextIfUnchanged, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"list", nullptr, List, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"stat", nullptr, Stat, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"exists", nullptr, Exists, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"mkdir", nullptr, Mkdir, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"remove", nullptr, Remove, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

}  // namespace

NAPI_MODULE_INIT() {
  return Init(env, exports);
}
